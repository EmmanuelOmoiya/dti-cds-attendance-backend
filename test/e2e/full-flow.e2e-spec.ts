import { createTestApp, createUser, login, resetDb, TestApp } from '../helpers/app';
import { Api } from '../helpers/api';

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

/**
 * The end-to-end scenario from the requirements, driven only through the public HTTP API:
 *   1 create group · 2 register member · 3 register card · 4 create session · 5 register device
 *   6 upload attendance · 7 retry the same upload · 8 exactly one record · 9 view attendance · 10 report
 * followed by the synchronization protocol edge cases.
 */
describe('End-to-end: offline attendance from registration to report', () => {
  let t: TestApp;
  let anon: Api;
  let admin: Api;

  beforeAll(async () => {
    t = await createTestApp();
    anon = new Api(t);
    await resetDb(t.prisma);
    await createUser(t.prisma, { email: 'root@dti.test', role: 'SUPER_ADMIN' });
    admin = anon.as(await login(t, 'root@dti.test'));
  });
  afterAll(() => t.close());

  // Shared state built up by the ordered steps below.
  const s: Record<string, string> = {};
  let device: Api;
  const firstUpload = () => ({
    batchId: 'batch-001',
    deviceTime: new Date().toISOString(),
    events: [{ clientEventId: 'ATT-123', cardUid: '04:A1:B2:C3:D4:E5:F6', capturedAt: s.tapTime, sessionId: s.sessionId }],
  });

  it('1. create a CDS group', async () => {
    const res = await admin.post('/groups', { name: 'dti CDS Ikeja', description: 'Digital Literacy 4 All' }).expect(201);
    s.groupId = res.body.data.id;
  });

  it('2. register a member into the group', async () => {
    const res = await admin.post('/members', { fullName: 'Adaeze Okafor', stateCode: 'LA/25A/1234', groupId: s.groupId, joinedAt: at(-30 * DAY) }).expect(201);
    s.memberId = res.body.data.id;
  });

  it('3. register an NFC card and assign it to the member', async () => {
    const card = await admin.post('/cards', { cardUid: '04A1B2C3D4E5F6', label: 'Card 001' }).expect(201);
    await admin.post('/card-assignments', { cardId: card.body.data.id, memberId: s.memberId, assignedAt: at(-30 * DAY) }).expect(201);
  });

  it('4. create a session (meeting in progress) and open it', async () => {
    const res = await admin.post('/sessions', { groupId: s.groupId, title: 'Weekly CDS', plannedStart: at(-30 * MIN), plannedEnd: at(2 * HOUR) }).expect(201);
    s.sessionId = res.body.data.id;
    await admin.post(`/sessions/${s.sessionId}/open`).expect(200);
    s.tapTime = at(-5 * MIN);
  });

  it('5. register and activate a device, which authenticates with its own secret', async () => {
    const reg = await admin.post('/devices', { deviceIdentifier: 'dti-dev-0001', name: 'Main reader', assignedGroupId: s.groupId }).expect(201);
    s.deviceId = reg.body.data.device.id;
    expect(reg.body.data.device.status).toBe('PENDING');
    await admin.post(`/devices/${s.deviceId}/activate`).expect(200);
    const tok = await anon.post('/sync/token', { deviceIdentifier: 'dti-DEV-0001', secret: reg.body.data.credentials.secret }).expect(200);
    device = anon.as(tok.body.data.accessToken);
    const snap = await device.get('/sync/snapshot').expect(200);
    expect(snap.body.data.roster).toEqual([expect.objectContaining({ cardUid: '04A1B2C3D4E5F6', memberId: s.memberId })]);
    expect(snap.body.data.sessions.map((x: { id: string }) => x.id)).toContain(s.sessionId);
  });

  it('6. upload attendance captured offline', async () => {
    const res = await device.post('/sync/attendance-batches', firstUpload()).expect(200);
    expect(res.body.data.results).toEqual([{ clientEventId: 'ATT-123', status: 'ACCEPTED', attendanceRecordId: expect.any(String) }]);
    expect(res.body.data.summary).toMatchObject({ received: 1, accepted: 1 });
    s.recordId = res.body.data.results[0].attendanceRecordId;
  });

  it('7. retry the same upload (response was lost) — the acknowledgement is identical', async () => {
    const res = await device.post('/sync/attendance-batches', firstUpload()).expect(200);
    expect(res.body.data.results).toEqual([{ clientEventId: 'ATT-123', status: 'ACCEPTED', attendanceRecordId: s.recordId }]);
  });

  it('8. exactly one attendance record exists', async () => {
    expect(await t.prisma.attendanceRecord.count({ where: { sessionId: s.sessionId, memberId: s.memberId } })).toBe(1);
    expect(await t.prisma.attendanceEvent.count({ where: { clientEventId: 'ATT-123' } })).toBe(1);
  });

  it('9. view attendance', async () => {
    const list = await admin.get(`/attendance?sessionId=${s.sessionId}`).expect(200);
    expect(list.body.meta.total).toBe(1);
    expect(list.body.data[0]).toMatchObject({ id: s.recordId, source: 'DEVICE', status: 'PRESENT', member: { stateCode: 'LA/25A/1234' } });
    const view = await admin.get(`/sessions/${s.sessionId}/attendance?state=present`).expect(200);
    expect(view.body.data.members).toHaveLength(1);
  });

  it('10. generate reports (JSON and CSV) once the meeting is closed', async () => {
    await admin.post(`/sessions/${s.sessionId}/close`).expect(200);
    const session = await admin.get(`/reports/sessions/${s.sessionId}`).expect(200);
    expect(session.body.data.summary).toMatchObject({ countsTowardStatistics: true, eligible: 1, present: 1, absent: 0, attendanceRate: 100 });
    const group = await admin.get(`/reports/groups/${s.groupId}`).expect(200);
    expect(group.body.data.totals).toMatchObject({ heldSessions: 1, totalEligible: 1, totalPresent: 1, attendanceRate: 100 });
    const member = await admin.get(`/reports/members/${s.memberId}`).expect(200);
    expect(member.body.data.summary).toMatchObject({ eligibleSessions: 1, present: 1, attendanceRate: 100 });

    const csv = await admin.get(`/reports/groups/${s.groupId}/members?format=csv`).expect(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.headers['content-disposition']).toMatch(/attachment; filename=".+\.csv"/);
    expect(csv.text).toContain('State code,Full name,Eligible sessions,Present,Absent,Attendance %');
    expect(csv.text).toContain('LA/25A/1234,Adaeze Okafor,1,1,0,100');
  });

  describe('synchronization protocol', () => {
    it('snapshot supports ETag / 304 Not Modified and changes when the roster changes', async () => {
      const first = await device.get('/sync/snapshot').expect(200);
      const etag = first.headers.etag;
      expect(etag).toBe(`"${first.body.data.snapshotVersion}"`);
      await device.get('/sync/snapshot').set('If-None-Match', etag).expect(304);
      const m2 = await admin.post('/members', { fullName: 'Babatunde Adeyemi', stateCode: 'LA/25A/1235', groupId: s.groupId, joinedAt: at(-30 * DAY) }).expect(201);
      s.member2 = m2.body.data.id;
      await admin.post('/card-assignments', { cardUid: '04A1B2C3D4E5F7', memberId: s.member2, assignedAt: at(-30 * DAY) }).expect(201);
      const changed = await device.get('/sync/snapshot').set('If-None-Match', etag).expect(200);
      expect(changed.body.data.roster).toHaveLength(2);
    });

    it('a mixed batch gets one result per event, in submission order (partial failure is not batch failure)', async () => {
      const live = await admin.post('/sessions', { groupId: s.groupId, title: 'Second meeting', plannedStart: at(3 * HOUR), plannedEnd: at(5 * HOUR) }).expect(201);
      const cancelled = await admin.post('/sessions', { groupId: s.groupId, title: 'Cancelled', plannedStart: at(-1 * DAY), plannedEnd: at(-1 * DAY + 2 * HOUR) }).expect(201);
      await admin.post(`/sessions/${cancelled.body.data.id}/cancel`, { reason: 'WEATHER' }).expect(200);
      const batch = {
        batchId: 'batch-002',
        events: [
          { clientEventId: 'B2-1', cardUid: '04A1B2C3D4E5F7', capturedAt: at(-10 * MIN), sessionId: s.sessionId }, // member 2, session closed now but tap was during it → ok
          { clientEventId: 'B2-2', cardUid: '04DEADBEEF0001', capturedAt: at(-9 * MIN) }, // unknown card
          { clientEventId: 'B2-3', cardUid: '04A1B2C3D4E5F6', capturedAt: at(-8 * MIN), sessionId: s.sessionId }, // member 1 again
          { clientEventId: 'B2-4', cardUid: '04A1B2C3D4E5F6', capturedAt: at(-1 * DAY + 30 * MIN), sessionId: cancelled.body.data.id }, // cancelled
          { clientEventId: 'B2-5', cardUid: '04A1B2C3D4E5F6', capturedAt: '1970-01-01T00:00:05Z' }, // reset device clock
          { clientEventId: 'B2-6', cardUid: '04A1B2C3D4E5F6', capturedAt: at(-1 * MIN), sessionId: live.body.data.id }, // before window
        ],
      };
      const res = await device.post('/sync/attendance-batches', batch).expect(200);
      expect(res.body.data.results.map((r: { clientEventId: string; status: string; reasonCode?: string }) => [r.clientEventId, r.status, r.reasonCode ?? null])).toEqual([
        ['B2-1', 'ACCEPTED', null],
        ['B2-2', 'REJECTED', 'UNKNOWN_CARD'],
        ['B2-3', 'ALREADY_RECORDED', null],
        ['B2-4', 'REJECTED', 'SESSION_CANCELLED'],
        ['B2-5', 'REJECTED', 'INVALID_TIMESTAMP'],
        ['B2-6', 'REJECTED', 'SESSION_NOT_OPEN'],
      ]);
      expect(res.body.data.summary).toEqual({ received: 6, accepted: 1, alreadyRecorded: 1, rejected: 4, retry: 0 });

      // Rejected taps are retained for audit and review.
      const inbox = await admin.get('/attendance/events?ackStatus=REJECTED').expect(200);
      expect(inbox.body.meta.total).toBe(4);
    });

    it('re-sending an entire batch is idempotent', async () => {
      const before = await t.prisma.attendanceRecord.count();
      const again = await device.post('/sync/attendance-batches', { batchId: 'batch-002-retry', events: [{ clientEventId: 'B2-1', cardUid: '04A1B2C3D4E5F7', capturedAt: '2000-01-01T00:00:00Z' }] }).expect(200);
      // Same id but different payload → DUPLICATE_EVENT, original untouched.
      expect(again.body.data.results[0]).toMatchObject({ status: 'REJECTED', reasonCode: 'DUPLICATE_EVENT' });
      const events = await t.prisma.attendanceEvent.findMany({ where: { clientEventId: { startsWith: 'B2-' } }, orderBy: { clientEventId: 'asc' } });
      const replay = await device
        .post('/sync/attendance-batches', {
          batchId: 'batch-002-replay',
          events: events.map((e) => ({ clientEventId: e.clientEventId, cardUid: e.cardUid, capturedAt: e.capturedAt.toISOString(), ...(e.claimedSessionId ? { sessionId: e.claimedSessionId } : {}) })),
        })
        .expect(200);
      expect(replay.body.data.summary).toMatchObject({ received: 6, accepted: 1, alreadyRecorded: 1, rejected: 4 });
      expect(await t.prisma.attendanceRecord.count()).toBe(before);
    });

    it('duplicate events inside one batch are handled once', async () => {
      const ev = { clientEventId: 'DUP-IN-BATCH', cardUid: '04DEADBEEF0002', capturedAt: at(-2 * MIN) };
      const res = await device.post('/sync/attendance-batches', { batchId: 'batch-003', events: [ev, ev] }).expect(200);
      expect(res.body.data.results.map((r: { status: string }) => r.status)).toEqual(['REJECTED', 'REJECTED']);
      expect(await t.prisma.attendanceEvent.count({ where: { clientEventId: 'DUP-IN-BATCH' } })).toBe(1);
    });

    it('offline tap uploaded after the session closed is accepted on tap time (lateSync); a tap after close is not', async () => {
      const past = await admin.post('/sessions', { groupId: s.groupId, title: 'Yesterday', plannedStart: at(-20 * HOUR), plannedEnd: at(-17 * HOUR) }).expect(201);
      await admin.post(`/sessions/${past.body.data.id}/confirm-held`, { note: 'Held, device was offline' }).expect(200);
      const res = await device
        .post('/sync/attendance-batches', {
          batchId: 'batch-late',
          events: [
            { clientEventId: 'LATE-1', cardUid: '04A1B2C3D4E5F6', capturedAt: at(-18 * HOUR), sessionId: past.body.data.id },
            { clientEventId: 'LATE-2', cardUid: '04A1B2C3D4E5F7', capturedAt: at(-15 * HOUR), sessionId: past.body.data.id },
          ],
        })
        .expect(200);
      expect(res.body.data.results.map((r: { status: string }) => r.status)).toEqual(['ACCEPTED', 'REJECTED']);
      expect(res.body.data.results[1].reasonCode).toBe('SESSION_NOT_OPEN');
      const rec = await admin.get(`/attendance/${res.body.data.results[0].attendanceRecordId}`).expect(200);
      expect(rec.body.data).toMatchObject({ lateSync: true, source: 'DEVICE' });
    });

    it('membership rules apply to taps: not-in-group and not-yet-eligible are rejected; correcting data + reprocess recovers', async () => {
      const otherGroup = (await admin.post('/groups', { name: 'Other group' }).expect(201)).body.data.id;
      const outsider = await admin.post('/members', { fullName: 'Outsider', stateCode: 'LA/25A/9999', groupId: otherGroup, joinedAt: at(-30 * DAY) }).expect(201);
      await admin.post('/card-assignments', { cardUid: '04AAAA00000001', memberId: outsider.body.data.id, assignedAt: at(-30 * DAY) }).expect(201);
      const newbie = await admin.post('/members', { fullName: 'Newbie', stateCode: 'LA/25B/0001', groupId: s.groupId, joinedAt: at(-1 * HOUR) }).expect(201);
      await admin.post('/card-assignments', { cardUid: '04AAAA00000002', memberId: newbie.body.data.id, assignedAt: at(-30 * DAY) }).expect(201);

      const meeting = await admin.post('/sessions', { groupId: s.groupId, title: 'Started before newbie joined', plannedStart: at(-2 * HOUR), plannedEnd: at(-90 * MIN) }).expect(201);
      const res = await device
        .post('/sync/attendance-batches', {
          batchId: 'batch-membership',
          events: [
            { clientEventId: 'MEM-1', cardUid: '04AAAA00000001', capturedAt: at(-100 * MIN), sessionId: meeting.body.data.id },
            { clientEventId: 'MEM-2', cardUid: '04AAAA00000002', capturedAt: at(-100 * MIN), sessionId: meeting.body.data.id },
          ],
        })
        .expect(200);
      expect(res.body.data.results.map((r: { reasonCode: string }) => r.reasonCode)).toEqual(['MEMBER_NOT_IN_GROUP', 'NOT_ELIGIBLE_FOR_SESSION']);

      // The newbie actually joined a day earlier (data-entry mistake): correct, then reprocess.
      await admin.patch(`/memberships/${newbie.body.data.memberships[0].id}`, { joinedAt: at(-1 * DAY), note: 'Posting letter dated yesterday' }).expect(200);
      const rep = await admin.post('/attendance/events/reprocess', { sessionId: meeting.body.data.id }).expect(200);
      expect(rep.body.data.results.map((r: { outcome: string }) => r.outcome).sort()).toEqual(['RECORD_CREATED', 'STILL_REJECTED']);
    });

    it('oversized and malformed batches are refused as a whole and logged as failed syncs', async () => {
      const events = Array.from({ length: 51 }, (_, i) => ({ clientEventId: `BIG-${i}`, cardUid: '04A1B2C3D4E5F6', capturedAt: at(-MIN) }));
      const big = await device.post('/sync/attendance-batches', { batchId: 'too-big', events }).expect(413);
      expect(big.body.error.code).toBe('BATCH_TOO_LARGE');
      await device.post('/sync/attendance-batches', { batchId: 'bad', events: [{ clientEventId: 'has spaces!', cardUid: 'x', capturedAt: 'yesterday' }] }).expect(400);
      expect(await t.prisma.attendanceEvent.count({ where: { clientEventId: { startsWith: 'BIG-' } } })).toBe(0);
      const history = await admin.get(`/devices/${s.deviceId}/sync-events?type=UPLOAD`).expect(200);
      expect(history.body.data.some((e: { result: string; errorCode: string }) => e.result === 'FAILED' && e.errorCode === 'BATCH_TOO_LARGE')).toBe(true);
    });

    it('heartbeat records device status, visible to administrators with last sync', async () => {
      const hb = await device.post('/sync/heartbeat', { deviceTime: at(-2 * MIN), firmwareVersion: '1.0.3', batteryPct: 76, pendingEvents: 3, bootId: 'boot-7' }).expect(200);
      expect(hb.body.data.clockSkewMs).toBeGreaterThan(100_000);
      const d = await admin.get(`/devices/${s.deviceId}`).expect(200);
      expect(d.body.data).toMatchObject({ status: 'ACTIVE', reportedPendingEvents: 3, lastStatus: expect.objectContaining({ firmwareVersion: '1.0.3', batteryPct: 76 }) });
      expect(d.body.data.lastSyncAt).not.toBeNull();
      expect(d.body.data.lastUpload).toMatchObject({ type: 'UPLOAD' });
    });

    it('synchronization and security events are audited', async () => {
      const actions = new Set((await t.prisma.auditLog.findMany({ select: { action: true } })).map((a) => a.action));
      for (const a of ['device.registered', 'device.activated', 'device.authenticated', 'sync.batch_processed', 'session.opened', 'membership.corrected', 'attendance.event_reprocessed']) {
        expect(actions).toContain(a);
      }
    });
  });
});
