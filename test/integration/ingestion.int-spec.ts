import { AttendanceIngestionService, IngestContext } from '../../src/attendance/attendance-ingestion.service';
import { CardsService } from '../../src/cards/cards.service';
import { AccessScope } from '../../src/auth/access-scope';
import { UserActor } from '../../src/auth/actor';
import { ago, createTestApp, createUser, days, hours, minutes, resetDb, TestApp } from '../helpers/app';
import { Factory } from '../helpers/factory';

describe('Attendance ingestion (idempotency, concurrency, business rules against the DB)', () => {
  let t: TestApp;
  let f: Factory;
  let ingestion: AttendanceIngestionService;

  beforeAll(async () => {
    t = await createTestApp();
    f = new Factory(t.prisma);
    ingestion = t.app.get(AttendanceIngestionService);
  });
  beforeEach(() => resetDb(t.prisma));
  afterAll(() => t.close());

  async function scenario() {
    const group = await f.group();
    const { member, membership } = await f.member(group.id, ago(days(60)));
    const { card } = await f.card(member.id, ago(days(60)));
    const session = await f.session(group.id, ago(minutes(30)), new Date(Date.now() + hours(2)), 'OPEN');
    const { device } = await f.device(group.id);
    const ctx: IngestContext = { deviceId: device.id, deviceGroupId: group.id, receivedAt: new Date(), clockSkewMs: 0, syncEventId: null };
    return { group, member, membership, card, session, device, ctx };
  }

  it('the same event uploaded twice yields one record and the identical acknowledgement', async () => {
    const s = await scenario();
    const tap = { clientEventId: 'ATT-123', cardUid: s.card.cardUid, capturedAt: ago(minutes(5)), sessionId: s.session.id };
    const first = await ingestion.ingest(tap, s.ctx);
    const second = await ingestion.ingest(tap, { ...s.ctx, receivedAt: new Date() });
    expect(first).toMatchObject({ status: 'ACCEPTED' });
    expect(second).toMatchObject({ status: 'ACCEPTED', attendanceRecordId: first.attendanceRecordId, replayed: true });
    expect(await t.prisma.attendanceRecord.count()).toBe(1);
    expect(await t.prisma.attendanceEvent.count()).toBe(1);
  });

  it('concurrent retries of the same event never create duplicates', async () => {
    const s = await scenario();
    const tap = { clientEventId: 'ATT-RACE', cardUid: s.card.cardUid, capturedAt: ago(minutes(5)), sessionId: s.session.id };
    const results = await Promise.all(Array.from({ length: 8 }, () => ingestion.ingest(tap, s.ctx)));
    expect(new Set(results.map((r) => r.status))).toEqual(new Set(['ACCEPTED']));
    expect(new Set(results.map((r) => r.attendanceRecordId)).size).toBe(1);
    expect(await t.prisma.attendanceRecord.count()).toBe(1);
    expect(await t.prisma.attendanceEvent.count()).toBe(1);
  });

  it('the same member recorded concurrently from two devices yields one record', async () => {
    const s = await scenario();
    const { device: d2 } = await f.device(s.group.id);
    const [a, b] = await Promise.all([
      ingestion.ingest({ clientEventId: 'D1-1', cardUid: s.card.cardUid, capturedAt: ago(minutes(6)), sessionId: s.session.id }, s.ctx),
      ingestion.ingest({ clientEventId: 'D2-1', cardUid: s.card.cardUid, capturedAt: ago(minutes(5)), sessionId: s.session.id }, { ...s.ctx, deviceId: d2.id }),
    ]);
    expect([a.status, b.status].sort()).toEqual(['ACCEPTED', 'ALREADY_RECORDED']);
    expect(a.attendanceRecordId).toBe(b.attendanceRecordId);
    expect(await t.prisma.attendanceRecord.count()).toBe(1);
    expect(await t.prisma.attendanceEvent.count()).toBe(2);
  });

  it('a second tap by the same member is ALREADY_RECORDED (kept as an event)', async () => {
    const s = await scenario();
    await ingestion.ingest({ clientEventId: 'T1', cardUid: s.card.cardUid, capturedAt: ago(minutes(10)) }, s.ctx);
    const again = await ingestion.ingest({ clientEventId: 'T2', cardUid: s.card.cardUid, capturedAt: ago(minutes(9)) }, s.ctx);
    expect(again.status).toBe('ALREADY_RECORDED');
    expect(await t.prisma.attendanceEvent.count({ where: { ackStatus: 'ALREADY_RECORDED' } })).toBe(1);
  });

  it('reusing an event id for a different tap is rejected as DUPLICATE_EVENT and the original is untouched', async () => {
    const s = await scenario();
    await ingestion.ingest({ clientEventId: 'SAME', cardUid: s.card.cardUid, capturedAt: ago(minutes(10)) }, s.ctx);
    const other = await ingestion.ingest({ clientEventId: 'SAME', cardUid: s.card.cardUid, capturedAt: ago(minutes(3)) }, s.ctx);
    expect(other).toMatchObject({ status: 'REJECTED', reasonCode: 'DUPLICATE_EVENT' });
    expect(await t.prisma.attendanceEvent.count()).toBe(1);
  });

  it('rejected taps are retained with a structured reason (unknown card)', async () => {
    const s = await scenario();
    const r = await ingestion.ingest({ clientEventId: 'U1', cardUid: '04DEADBEEF0000', capturedAt: ago(minutes(5)) }, s.ctx);
    expect(r).toMatchObject({ status: 'REJECTED', reasonCode: 'UNKNOWN_CARD' });
    const ev = await t.prisma.attendanceEvent.findFirstOrThrow({ where: { clientEventId: 'U1' } });
    expect(ev).toMatchObject({ ackStatus: 'REJECTED', ackReason: 'UNKNOWN_CARD', cardUid: '04DEADBEEF0000' });
  });

  it('card replacement: old card valid before the replacement, revoked after; new card valid; history preserved', async () => {
    const s = await scenario();
    const admin = await createUser(t.prisma, { email: 'a@x.io', role: 'SUPER_ADMIN' });
    const actor: UserActor = { type: 'USER', id: admin.id, email: admin.email, role: 'SUPER_ADMIN', scope: AccessScope.global() };
    const beforeReplacement = ago(minutes(20));
    const { assignment } = await t.app.get(CardsService).replace(s.member.id, { newCardUid: '04NEWCARD00001'.replace('NEWCARD', 'ABCDEF0'), reason: 'LOST' }, actor);

    const oldBefore = await ingestion.ingest({ clientEventId: 'OLD-BEFORE', cardUid: s.card.cardUid, capturedAt: beforeReplacement }, s.ctx);
    expect(oldBefore.status).toBe('ACCEPTED');

    const s2 = await f.session(s.group.id, new Date(Date.now() + hours(3)), new Date(Date.now() + hours(5)), 'SCHEDULED');
    const oldAfter = await ingestion.ingest({ clientEventId: 'OLD-AFTER', cardUid: s.card.cardUid, capturedAt: new Date(Date.now() + minutes(1)), sessionId: s2.id }, s.ctx);
    expect(oldAfter).toMatchObject({ status: 'REJECTED', reasonCode: 'CARD_REVOKED' });

    const assignments = await t.prisma.cardAssignment.findMany({ where: { memberId: s.member.id }, orderBy: { assignedAt: 'asc' } });
    expect(assignments).toHaveLength(2);
    expect(assignments[0]).toMatchObject({ status: 'ENDED', endReason: 'REPLACED', replacedByAssignmentId: assignment.id });
    expect(assignments[1]).toMatchObject({ status: 'ACTIVE' });
    expect((await t.prisma.card.findUniqueOrThrow({ where: { id: s.card.id } })).status).toBe('REVOKED');
  });

  it('a tap on a cancelled session is rejected and stored', async () => {
    const s = await scenario();
    const c = await f.session(s.group.id, new Date(Date.now() + days(1)), new Date(Date.now() + days(1) + hours(2)), 'CANCELLED');
    const r = await ingestion.ingest({ clientEventId: 'C1', cardUid: s.card.cardUid, capturedAt: new Date(c.plannedStart.getTime() + minutes(10)), sessionId: c.id }, { ...s.ctx, receivedAt: new Date(Date.now() + days(1) + hours(1)) });
    expect(r).toMatchObject({ status: 'REJECTED', reasonCode: 'SESSION_CANCELLED' });
    expect(await t.prisma.attendanceRecord.count()).toBe(0);
  });
});
