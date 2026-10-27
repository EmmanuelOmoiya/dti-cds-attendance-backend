import { JobsService } from '../../src/jobs/jobs.service';
import { createTestApp, createUser, login, resetDb, TestApp } from '../helpers/app';
import { Api, provisionDevice } from '../helpers/api';

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

describe('Schedules and session lifecycle (HTTP)', () => {
  let t: TestApp;
  let anon: Api;
  let admin: Api;
  let group: string;
  let memberId: string;
  const cardUid = '04C0FFEE000001';

  beforeAll(async () => {
    t = await createTestApp();
    anon = new Api(t);
  });
  afterAll(() => t.close());

  beforeEach(async () => {
    await resetDb(t.prisma);
    await createUser(t.prisma, { email: 'root@dti.test', role: 'SUPER_ADMIN' });
    admin = anon.as(await login(t, 'root@dti.test'));
    group = (await admin.post('/groups', { name: 'Group A' }).expect(201)).body.data.id;
    memberId = (await admin.post('/members', { fullName: 'Ada', stateCode: 'LA/25A/0001', groupId: group, joinedAt: at(-60 * DAY) }).expect(201)).body.data.id;
    await admin.post('/card-assignments', { cardUid, memberId, assignedAt: at(-60 * DAY) }).expect(201);
  });

  const adHoc = async (startOffset: number, durationMs = 2 * HOUR) =>
    (await admin.post('/sessions', { groupId: group, title: 'Meeting', plannedStart: at(startOffset), plannedEnd: at(startOffset + durationMs) }).expect(201)).body.data;

  it('a recurring schedule generates expected (not held) sessions ~6 weeks ahead', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const res = await admin.post('/schedules', { groupId: group, title: 'Friday CDS', dayOfWeek: 5, startLocalTime: '10:00', endLocalTime: '13:00', effectiveFrom: today }).expect(201);
    expect(res.body.data.generation.created).toBeGreaterThanOrEqual(6);
    const list = await admin.get(`/sessions?scheduleId=${res.body.data.id}&sort=plannedStart:asc`).expect(200);
    expect(list.body.data.every((s: { status: string; held: boolean }) => s.status === 'SCHEDULED' && !s.held)).toBe(true);
    const preview = await admin.get(`/schedules/${res.body.data.id}/occurrences/preview?from=${today}&to=${new Date(Date.now() + 14 * DAY).toISOString().slice(0, 10)}`).expect(200);
    expect(preview.body.data.length).toBeGreaterThanOrEqual(2);
  });

  it('open → close: the meeting is confirmed held live, then attendance closes', async () => {
    const s = await adHoc(-10 * MIN);
    const opened = await admin.post(`/sessions/${s.id}/open`).expect(200);
    expect(opened.body.data).toMatchObject({ status: 'OPEN', heldConfirmation: 'OPENED_LIVE', held: true });
    const closed = await admin.post(`/sessions/${s.id}/close`).expect(200);
    expect(closed.body.data.status).toBe('CLOSED');
    await admin.post(`/sessions/${s.id}/open`).expect(409);
  });

  it('a future session cannot be opened early or confirmed held, and taps before its window are rejected', async () => {
    const s = await adHoc(3 * DAY);
    expect((await admin.post(`/sessions/${s.id}/open`).expect(422)).body.error.code).toBe('SESSION_OPEN_OUT_OF_RANGE');
    expect((await admin.post(`/sessions/${s.id}/confirm-held`, {}).expect(422)).body.error.code).toBe('SESSION_NOT_ENDED');
    const d = await provisionDevice(admin, anon, group, 'DEV-1');
    const up = await anon.as(d.token).post('/sync/attendance-batches', { batchId: 'b1', events: [{ clientEventId: 'E1', cardUid, capturedAt: at(-MIN), sessionId: s.id }] }).expect(200);
    expect(up.body.data.results[0]).toMatchObject({ status: 'REJECTED', reasonCode: 'SESSION_NOT_OPEN' });
  });

  it('cancellation requires a valid reason; reasons are stored; system-only reasons are refused', async () => {
    const s = await adHoc(2 * DAY);
    await admin.post(`/sessions/${s.id}/cancel`, { reason: 'SCHEDULE_CHANGED' }).expect(400);
    await admin.post(`/sessions/${s.id}/cancel`, {}).expect(400);
    const res = await admin.post(`/sessions/${s.id}/cancel`, { reason: 'PUBLIC_HOLIDAY', note: 'Independence Day' }).expect(200);
    expect(res.body.data).toMatchObject({ status: 'CANCELLED', cancellationReason: 'PUBLIC_HOLIDAY', cancellationNote: 'Independence Day', held: false });
  });

  it('a cancelled session does not accept attendance (device or manual)', async () => {
    const s = await adHoc(-30 * MIN);
    await admin.post(`/sessions/${s.id}/cancel`, { reason: 'VENUE_UNAVAILABLE' }).expect(200);
    const d = await provisionDevice(admin, anon, group, 'DEV-1');
    const up = await anon.as(d.token).post('/sync/attendance-batches', { batchId: 'b1', events: [{ clientEventId: 'E1', cardUid, capturedAt: at(-MIN), sessionId: s.id }] }).expect(200);
    expect(up.body.data.results[0]).toMatchObject({ status: 'REJECTED', reasonCode: 'SESSION_CANCELLED' });
    expect((await admin.post('/attendance', { sessionId: s.id, memberId, note: 'manual attempt' }).expect(422)).body.error.code).toBe('SESSION_CANCELLED');
  });

  it('cancelling a session with attendance requires voiding it; reinstating restores it and recovers rejected taps', async () => {
    const s = await adHoc(-30 * MIN);
    await admin.post(`/sessions/${s.id}/open`).expect(200);
    const d = await provisionDevice(admin, anon, group, 'DEV-1');
    await anon.as(d.token).post('/sync/attendance-batches', { batchId: 'b1', events: [{ clientEventId: 'E1', cardUid, capturedAt: at(-5 * MIN), sessionId: s.id }] }).expect(200);

    const blocked = await admin.post(`/sessions/${s.id}/cancel`, { reason: 'NOT_HELD' }).expect(409);
    expect(blocked.body.error).toMatchObject({ code: 'SESSION_HAS_ATTENDANCE', details: { presentRecords: 1 } });
    const cancelled = await admin.post(`/sessions/${s.id}/cancel`, { reason: 'NOT_HELD', voidExistingAttendance: true }).expect(200);
    expect(cancelled.body.data.voidedRecords).toBe(1);
    expect(await t.prisma.attendanceRecord.count({ where: { status: 'PRESENT' } })).toBe(0);
    expect(await t.prisma.attendanceRecord.count()).toBe(1); // voided, not deleted

    const reinstated = await admin.post(`/sessions/${s.id}/reinstate`, { note: 'Cancelled by mistake' }).expect(200);
    expect(reinstated.body.data).toMatchObject({ status: 'SCHEDULED', restoredRecords: 1 });
  });

  it('taps rejected while a session was cancelled are recovered by reinstate + reprocess', async () => {
    const s = await adHoc(-30 * MIN);
    await admin.post(`/sessions/${s.id}/cancel`, { reason: 'NOT_HELD' }).expect(200);
    const d = await provisionDevice(admin, anon, group, 'DEV-1');
    const e1 = { clientEventId: 'E1', cardUid, capturedAt: at(-5 * MIN), sessionId: s.id };
    await anon.as(d.token).post('/sync/attendance-batches', { batchId: 'b1', events: [e1] }).expect(200);
    const res = await admin.post(`/sessions/${s.id}/reinstate`, { note: 'Meeting did happen', reprocessRejectedEvents: true }).expect(200);
    expect(res.body.data.reprocessing).toMatchObject({ evaluated: 1, recordsCreated: 1 });
    const records = await admin.get(`/attendance?sessionId=${s.id}`).expect(200);
    expect(records.body.data[0]).toMatchObject({ source: 'REPROCESSED', status: 'PRESENT' });
    // The device acknowledgement for E1 is unchanged — a retry still gets REJECTED/SESSION_CANCELLED.
    const retry = await anon.as(d.token).post('/sync/attendance-batches', { batchId: 'b2', events: [e1] }).expect(200);
    expect(retry.body.data.results[0]).toMatchObject({ status: 'REJECTED', reasonCode: 'SESSION_CANCELLED' });
  });

  it('an expected session with no action becomes UNRESOLVED (not cancelled) and can then be resolved either way', async () => {
    const a = await adHoc(-3 * DAY);
    const b = await adHoc(-4 * DAY);
    await t.app.get(JobsService).runMaintenance();
    const unresolved = await admin.get('/sessions?needsResolution=true').expect(200);
    expect(unresolved.body.data.map((s: { id: string }) => s.id).sort()).toEqual([a.id, b.id].sort());
    expect(await t.prisma.attendanceSession.count({ where: { status: 'CANCELLED' } })).toBe(0);

    await admin.post(`/sessions/${a.id}/confirm-held`, { note: 'Register confirms meeting' }).expect(200);
    await admin.post(`/sessions/${b.id}/cancel`, { reason: 'NOT_HELD', note: 'Nobody came' }).expect(200);
    const [ra, rb] = await Promise.all([admin.get(`/sessions/${a.id}`).expect(200), admin.get(`/sessions/${b.id}`).expect(200)]);
    expect(ra.body.data).toMatchObject({ status: 'CLOSED', heldConfirmation: 'CONFIRMED_RETROSPECTIVELY' });
    expect(rb.body.data).toMatchObject({ status: 'CANCELLED', cancellationReason: 'NOT_HELD' });
  });

  it('a single occurrence can be rescheduled before it has attendance', async () => {
    const s = await adHoc(5 * DAY);
    const moved = await admin.patch(`/sessions/${s.id}`, { plannedStart: at(6 * DAY), plannedEnd: at(6 * DAY + 2 * HOUR) }).expect(200);
    expect(moved.body.data.rescheduled).toBe(true);
    const clash = await adHoc(8 * DAY);
    const res = await admin.patch(`/sessions/${clash.id}`, { plannedStart: at(6 * DAY + HOUR), plannedEnd: at(6 * DAY + 3 * HOUR) }).expect(409);
    expect(res.body.error.code).toBe('SESSION_OVERLAP');
  });

  it('session lifecycle actions are audited', async () => {
    const s = await adHoc(-10 * MIN);
    await admin.post(`/sessions/${s.id}/open`).expect(200);
    await admin.post(`/sessions/${s.id}/close`).expect(200);
    const logs = await admin.get(`/audit-logs?entityId=${s.id}&sort=createdAt:asc`).expect(200);
    expect(logs.body.data.map((l: { action: string }) => l.action)).toEqual(['session.created', 'session.opened', 'session.closed']);
  });
});
