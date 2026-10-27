import { createTestApp, days, hours, resetDb, TestApp } from '../helpers/app';
import { Factory } from '../helpers/factory';
import { isExclusionViolation } from '../../src/common/errors/db-errors';

/**
 * The database — not just application code — enforces the core invariants. These tests talk to
 * Prisma directly, bypassing services, to prove the guarantees hold even against buggy code.
 */
describe('Database integrity constraints', () => {
  let t: TestApp;
  let f: Factory;

  beforeAll(async () => {
    t = await createTestApp();
    f = new Factory(t.prisma);
  });
  beforeEach(() => resetDb(t.prisma));
  afterAll(() => t.close());

  it('all hand-written constraints exist after migrating a clean database', async () => {
    const rows = await t.prisma.$queryRaw<{ conname: string }[]>`SELECT conname FROM pg_constraint WHERE contype IN ('x', 'c')`;
    const names = rows.map((r) => r.conname);
    for (const expected of [
      'GroupMembership_no_overlap',
      'CardAssignment_card_no_overlap',
      'CardAssignment_member_no_overlap',
      'AttendanceSession_no_overlap',
      'CdsSchedule_no_overlap',
      'AttendanceSession_cancelled_check',
      'AttendanceRecord_void_check',
      'AttendanceEvent_reason_check',
    ]) {
      expect(names).toContain(expected);
    }
  });

  it('a member cannot have overlapping group memberships', async () => {
    const g1 = await f.group();
    const g2 = await f.group();
    const { member } = await f.member(g1.id, new Date(Date.now() - days(30)));
    const err = await t.prisma.groupMembership.create({ data: { memberId: member.id, groupId: g2.id, joinedAt: new Date() } }).catch((e) => e);
    expect(isExclusionViolation(err, 'GroupMembership_no_overlap')).toBe(true);
  });

  it('back-to-back memberships ([a,b) then [b,…)) are allowed', async () => {
    const g1 = await f.group();
    const g2 = await f.group();
    const b = new Date(Date.now() - days(1));
    const { member } = await f.member(g1.id, new Date(Date.now() - days(30)), { leftAt: b });
    await expect(t.prisma.groupMembership.create({ data: { memberId: member.id, groupId: g2.id, joinedAt: b } })).resolves.toBeDefined();
  });

  it('a card cannot be held by two members at once, and a member cannot hold two cards at once', async () => {
    const g = await f.group();
    const { member: m1 } = await f.member(g.id, new Date(Date.now() - days(30)));
    const { member: m2 } = await f.member(g.id, new Date(Date.now() - days(30)));
    const { card } = await f.card(m1.id);
    const sameCard = await t.prisma.cardAssignment.create({ data: { cardId: card.id, memberId: m2.id, assignedAt: new Date() } }).catch((e) => e);
    expect(isExclusionViolation(sameCard, 'CardAssignment_card_no_overlap')).toBe(true);

    const other = await t.prisma.card.create({ data: { cardUid: '04AABBCCDDEE99' } });
    const secondCard = await t.prisma.cardAssignment.create({ data: { cardId: other.id, memberId: m1.id, assignedAt: new Date() } }).catch((e) => e);
    expect(isExclusionViolation(secondCard, 'CardAssignment_member_no_overlap')).toBe(true);
  });

  it('sessions of the same group cannot overlap unless cancelled', async () => {
    const g = await f.group();
    const start = new Date(Date.now() + days(2));
    await f.session(g.id, start, new Date(start.getTime() + hours(3)));
    const err = await f.session(g.id, new Date(start.getTime() + hours(1)), new Date(start.getTime() + hours(4))).catch((e) => e);
    expect(isExclusionViolation(err, 'AttendanceSession_no_overlap')).toBe(true);
  });

  it('only one attendance record per member per session (unique), and records cannot be deleted', async () => {
    const g = await f.group();
    const { member, membership } = await f.member(g.id, new Date(Date.now() - days(30)));
    const s = await f.session(g.id, new Date(Date.now() - hours(3)), new Date(Date.now() - hours(1)), 'CLOSED');
    const data = { sessionId: s.id, memberId: member.id, membershipId: membership.id, source: 'MANUAL' as const, capturedAt: new Date() };
    const rec = await t.prisma.attendanceRecord.create({ data });
    await expect(t.prisma.attendanceRecord.create({ data })).rejects.toBeDefined();
    await expect(t.prisma.attendanceRecord.delete({ where: { id: rec.id } })).rejects.toBeDefined();
    expect(await t.prisma.attendanceRecord.count()).toBe(1);
  });

  it('device event identity is unique per device and its acknowledgement is immutable', async () => {
    const g = await f.group();
    const { device } = await f.device(g.id);
    const data = { deviceId: device.id, clientEventId: 'ATT-123', payloadHash: 'h', cardUid: '04AABBCCDD', capturedAt: new Date(), ackStatus: 'REJECTED' as const, ackReason: 'UNKNOWN_CARD' as const };
    const ev = await t.prisma.attendanceEvent.create({ data });
    await expect(t.prisma.attendanceEvent.create({ data })).rejects.toBeDefined();
    await expect(t.prisma.attendanceEvent.update({ where: { id: ev.id }, data: { ackStatus: 'ACCEPTED', ackReason: null } })).rejects.toBeDefined();
    await expect(t.prisma.attendanceEvent.delete({ where: { id: ev.id } })).rejects.toBeDefined();
    // Resolution fields may change (admin follow-up)
    await expect(t.prisma.attendanceEvent.update({ where: { id: ev.id }, data: { resolution: 'DISMISSED' } })).resolves.toBeDefined();
  });

  it('the audit log is append-only', async () => {
    const row = await t.prisma.auditLog.create({ data: { actorType: 'SYSTEM', action: 'test', entityType: 'X' } });
    await expect(t.prisma.auditLog.update({ where: { id: row.id }, data: { action: 'changed' } })).rejects.toBeDefined();
    await expect(t.prisma.auditLog.delete({ where: { id: row.id } })).rejects.toBeDefined();
  });

  it('device identifiers are unique', async () => {
    const g = await f.group();
    const { device } = await f.device(g.id);
    await expect(
      t.prisma.device.create({ data: { deviceIdentifier: device.deviceIdentifier, name: 'dup', assignedGroupId: g.id, secretHash: 'x' } }),
    ).rejects.toBeDefined();
  });
});
