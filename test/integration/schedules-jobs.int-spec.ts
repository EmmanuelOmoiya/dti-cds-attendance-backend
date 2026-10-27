import { AccessScope } from '../../src/auth/access-scope';
import { UserActor } from '../../src/auth/actor';
import { addDaysToIsoDate, localDate } from '../../src/common/time/dates';
import { JobsService } from '../../src/jobs/jobs.service';
import { SchedulesService } from '../../src/schedules/schedules.service';
import { SessionsService } from '../../src/sessions/sessions.service';
import { ago, createTestApp, createUser, days, hours, minutes, resetDb, TestApp } from '../helpers/app';
import { Factory } from '../helpers/factory';

describe('Recurring schedules and session maintenance jobs', () => {
  let t: TestApp;
  let f: Factory;
  let schedules: SchedulesService;
  let sessions: SessionsService;
  let jobs: JobsService;
  let actor: UserActor;

  beforeAll(async () => {
    t = await createTestApp();
    f = new Factory(t.prisma);
    schedules = t.app.get(SchedulesService);
    sessions = t.app.get(SessionsService);
    jobs = t.app.get(JobsService);
  });
  beforeEach(async () => {
    await resetDb(t.prisma);
    const admin = await createUser(t.prisma, { email: 'root@x.io', role: 'SUPER_ADMIN' });
    actor = { type: 'USER', id: admin.id, email: admin.email, role: 'SUPER_ADMIN', scope: AccessScope.global() };
  });
  afterAll(() => t.close());

  const today = () => localDate(new Date(), 'Africa/Lagos');

  it('creating a schedule generates ~6 weeks of expected sessions; regeneration is idempotent', async () => {
    const g = await f.group();
    const res = await schedules.create({ groupId: g.id, title: 'Friday CDS', dayOfWeek: 5, startLocalTime: '10:00', endLocalTime: '13:00', effectiveFrom: today() }, actor);
    expect(res.generation.created).toBeGreaterThanOrEqual(6);
    expect(res.generation.created).toBeLessThanOrEqual(7);
    const rows = await t.prisma.attendanceSession.findMany({ where: { scheduleId: res.id }, orderBy: { plannedStart: 'asc' } });
    expect(rows.every((r) => r.status === 'SCHEDULED' && r.origin === 'SCHEDULE')).toBe(true);
    expect(rows[0].plannedStart.getUTCHours()).toBe(9); // 10:00 Lagos = 09:00 UTC

    const again = await schedules.generateAll(new Date());
    expect(again.reduce((a, r) => a + r.created, 0)).toBe(0);
    expect(await t.prisma.attendanceSession.count({ where: { scheduleId: res.id } })).toBe(rows.length);
  });

  it('back-filled past occurrences start UNRESOLVED, never CANCELLED', async () => {
    const g = await f.group();
    const res = await schedules.create(
      { groupId: g.id, title: 'Monday CDS', dayOfWeek: 1, startLocalTime: '10:00', endLocalTime: '12:00', effectiveFrom: addDaysToIsoDate(today(), -28), backfillPast: true },
      actor,
    );
    const past = await t.prisma.attendanceSession.findMany({ where: { scheduleId: res.id, plannedEnd: { lt: ago(hours(25)) } } });
    expect(past.length).toBeGreaterThanOrEqual(3);
    expect(past.every((p) => p.status === 'UNRESOLVED')).toBe(true);
  });

  it('a SCHEDULED session becomes UNRESOLVED 24h after its planned end (and not before)', async () => {
    const g = await f.group();
    const old = await f.session(g.id, ago(hours(28)), ago(hours(25)));
    const recent = await f.session(g.id, ago(hours(10)), ago(hours(8)));
    const res = await jobs.runMaintenance();
    expect(res).toMatchObject({ ran: true, markedUnresolved: 1 });
    expect((await t.prisma.attendanceSession.findUniqueOrThrow({ where: { id: old.id } })).status).toBe('UNRESOLVED');
    expect((await t.prisma.attendanceSession.findUniqueOrThrow({ where: { id: recent.id } })).status).toBe('SCHEDULED');
    expect(await t.prisma.attendanceSession.count({ where: { status: 'CANCELLED' } })).toBe(0);
    expect(await t.prisma.auditLog.count({ where: { action: 'session.marked_unresolved', actorType: 'SYSTEM' } })).toBe(1);
  });

  it('an OPEN session is auto-closed at planned end + close grace', async () => {
    const g = await f.group();
    const s = await f.session(g.id, ago(hours(3)), ago(hours(1)), 'OPEN');
    await jobs.runMaintenance();
    const after = await t.prisma.attendanceSession.findUniqueOrThrow({ where: { id: s.id } });
    expect(after.status).toBe('CLOSED');
    expect(after.closedAt!.getTime()).toBe(s.plannedEnd.getTime() + minutes(30));
  });

  it('an UNRESOLVED session can be resolved as held or as cancelled', async () => {
    const g = await f.group();
    const a = await f.session(g.id, ago(days(3)), ago(days(3) - hours(2)), 'UNRESOLVED');
    const b = await f.session(g.id, ago(days(10)), ago(days(10) - hours(2)), 'UNRESOLVED');
    const held = await sessions.confirmHeld(a.id, {}, actor);
    expect(held).toMatchObject({ status: 'CLOSED', heldConfirmation: 'CONFIRMED_RETROSPECTIVELY' });
    const cancelled = await sessions.cancel(b.id, { reason: 'NOT_HELD', note: 'No quorum' }, actor);
    expect(cancelled).toMatchObject({ status: 'CANCELLED', cancellationReason: 'NOT_HELD', cancellationNote: 'No quorum' });
  });

  it('ending a schedule cancels only untouched future occurrences; history and sessions with data are preserved', async () => {
    const g = await f.group();
    const res = await schedules.create(
      { groupId: g.id, title: 'Friday CDS', dayOfWeek: 5, startLocalTime: '10:00', endLocalTime: '13:00', effectiveFrom: addDaysToIsoDate(today(), -21), backfillPast: true },
      actor,
    );
    const all = await t.prisma.attendanceSession.findMany({ where: { scheduleId: res.id }, orderBy: { plannedStart: 'asc' } });
    const past = all.filter((s) => s.plannedEnd < new Date());
    const future = all.filter((s) => s.plannedStart > new Date());
    // A past meeting was held; one future occurrence already has a (test) device event.
    await sessions.confirmHeld(past[0].id, {}, actor);
    const { device } = await f.device(g.id);
    await t.prisma.attendanceEvent.create({
      data: { deviceId: device.id, clientEventId: 'E1', payloadHash: 'h', cardUid: '04AABBCCDD', capturedAt: new Date(), sessionId: future[2].id, ackStatus: 'REJECTED', ackReason: 'UNKNOWN_CARD' },
    });

    const ended = await schedules.end(res.id, today(), actor);
    expect(ended.sessionsKeptWithAttendance.map((s) => s.id)).toEqual([future[2].id]);
    expect(ended.cancelledSessionIds).toHaveLength(future.length - 1);

    const after = await t.prisma.attendanceSession.findMany({ where: { scheduleId: res.id } });
    const byId = Object.fromEntries(after.map((s) => [s.id, s]));
    expect(byId[past[0].id].status).toBe('CLOSED'); // historical meeting untouched
    expect(byId[future[2].id].status).toBe('SCHEDULED');
    expect(after.filter((s) => s.cancellationReason === 'SCHEDULE_CHANGED')).toHaveLength(future.length - 1);

    // A replacement schedule on another weekday generates its own sessions.
    const next = await schedules.create({ groupId: g.id, title: 'Monday CDS', dayOfWeek: 1, startLocalTime: '10:00', endLocalTime: '13:00', effectiveFrom: addDaysToIsoDate(today(), 1) }, actor);
    expect(next.generation.created).toBeGreaterThan(0);
    expect((await t.prisma.cdsSchedule.findUniqueOrThrow({ where: { id: res.id } })).effectiveUntil).not.toBeNull();
  });

  it('two overlapping active schedules for the same weekday are refused', async () => {
    const g = await f.group();
    await schedules.create({ groupId: g.id, title: 'A', dayOfWeek: 3, startLocalTime: '10:00', endLocalTime: '12:00', effectiveFrom: today() }, actor);
    await expect(
      schedules.create({ groupId: g.id, title: 'B', dayOfWeek: 3, startLocalTime: '14:00', endLocalTime: '16:00', effectiveFrom: today() }, actor),
    ).rejects.toMatchObject({ code: 'SCHEDULE_OVERLAP' });
  });
});
