import { createTestApp, createUser, login, resetDb, TestApp } from '../helpers/app';
import { Api, provisionDevice } from '../helpers/api';

describe('Device trust and security (HTTP)', () => {
  let t: TestApp;
  let anon: Api;
  let admin: Api;
  let groupA: string;
  let groupB: string;
  let sessionA: string;
  const cardUid = '04A1B2C3D4E5F6';

  beforeAll(async () => {
    t = await createTestApp();
    anon = new Api(t);
  });
  afterAll(() => t.close());

  beforeEach(async () => {
    await resetDb(t.prisma);
    await createUser(t.prisma, { email: 'root@dti.test', role: 'SUPER_ADMIN' });
    admin = anon.as(await login(t, 'root@dti.test'));
    groupA = (await admin.post('/groups', { name: 'Group A' }).expect(201)).body.data.id;
    groupB = (await admin.post('/groups', { name: 'Group B' }).expect(201)).body.data.id;
    const member = await admin.post('/members', { fullName: 'Ada Obi', stateCode: 'LA/25A/0001', groupId: groupA, joinedAt: new Date(Date.now() - 30 * 86_400_000).toISOString() }).expect(201);
    await admin.post('/card-assignments', { cardUid, memberId: member.body.data.id, assignedAt: new Date(Date.now() - 30 * 86_400_000).toISOString() }).expect(201);
    const s = await admin
      .post('/sessions', { groupId: groupA, title: 'Live meeting', plannedStart: new Date(Date.now() - 600_000).toISOString(), plannedEnd: new Date(Date.now() + 7_200_000).toISOString() })
      .expect(201);
    sessionA = s.body.data.id;
    await admin.post(`/sessions/${sessionA}/open`).expect(200);
  });

  const tap = (id: string, sessionId?: string) => ({ clientEventId: id, cardUid, capturedAt: new Date(Date.now() - 60_000).toISOString(), ...(sessionId ? { sessionId } : {}) });
  const upload = (token: string, events: object[]) => anon.as(token).post('/sync/attendance-batches', { batchId: `b-${Date.now()}`, events });

  it('an ACTIVE device with valid credentials authenticates and syncs', async () => {
    const d = await provisionDevice(admin, anon, groupA, 'DEV-A-1');
    const snap = await anon.as(d.token).get('/sync/snapshot').expect(200);
    expect(snap.body.data.group.id).toBe(groupA);
    expect(snap.body.data.roster).toHaveLength(1);
    const up = await upload(d.token, [tap('E1', sessionA)]).expect(200);
    expect(up.body.data.results[0].status).toBe('ACCEPTED');
  });

  it('an unknown device and an invalid secret both get the same 401 and are audited', async () => {
    await provisionDevice(admin, anon, groupA, 'DEV-A-1');
    const unknown = await anon.post('/sync/token', { deviceIdentifier: 'NO-SUCH-DEVICE', secret: 'dsk_aaaaaaaaaaaaaaaaaaaaaaaa' }).expect(401);
    const wrong = await anon.post('/sync/token', { deviceIdentifier: 'DEV-A-1', secret: 'dsk_bbbbbbbbbbbbbbbbbbbbbbbb' }).expect(401);
    expect(unknown.body.error.code).toBe('DEVICE_AUTH_FAILED');
    expect(wrong.body.error).toEqual({ ...unknown.body.error, requestId: wrong.body.error.requestId });
    const failures = await t.prisma.auditLog.findMany({ where: { action: 'device.auth_failed' } });
    expect(failures.map((f) => (f.metadata as { reason: string }).reason).sort()).toEqual(['INVALID_CREDENTIAL', 'UNKNOWN_DEVICE']);
    expect(JSON.stringify(failures.map((f) => f.metadata))).not.toContain('dsk_bbbb');
  });

  it('a device identifier alone (no valid token) cannot access sync endpoints', async () => {
    await anon.get('/sync/snapshot').expect(401);
    await anon.as('DEV-A-1').get('/sync/snapshot').expect(401);
  });

  it('a PENDING (not yet activated) device is refused', async () => {
    const reg = await admin.post('/devices', { deviceIdentifier: 'DEV-P', name: 'Pending', assignedGroupId: groupA }).expect(201);
    const { credentials } = reg.body.data;
    const res = await anon.post('/sync/token', { deviceIdentifier: credentials.deviceIdentifier, secret: credentials.secret }).expect(403);
    expect(res.body.error).toMatchObject({ code: 'DEVICE_NOT_ACTIVE', details: { status: 'PENDING' } });
  });

  it('a SUSPENDED device is refused, including tokens issued before suspension, and works again once re-activated', async () => {
    const d = await provisionDevice(admin, anon, groupA, 'DEV-S');
    await admin.post(`/devices/${d.deviceId}/suspend`, { reason: 'Left at venue' }).expect(200);
    await anon.as(d.token).get('/sync/snapshot').expect(403);
    await anon.post('/sync/token', { deviceIdentifier: d.identifier, secret: d.secret }).expect(403);
    await admin.post(`/devices/${d.deviceId}/activate`).expect(200);
    await anon.as(d.token).get('/sync/snapshot').expect(200);
  });

  it('a REVOKED device is refused immediately and permanently; its historical attendance remains', async () => {
    const d = await provisionDevice(admin, anon, groupA, 'DEV-R');
    await upload(d.token, [tap('BEFORE-REVOKE', sessionA)]).expect(200);
    await admin.post(`/devices/${d.deviceId}/revoke`, { reason: 'Stolen' }).expect(200);
    await upload(d.token, [tap('AFTER-REVOKE', sessionA)]).expect(403);
    await anon.post('/sync/token', { deviceIdentifier: d.identifier, secret: d.secret }).expect(403);
    await admin.post(`/devices/${d.deviceId}/activate`).expect(409);
    expect(await t.prisma.attendanceRecord.count({ where: { deviceId: d.deviceId } })).toBe(1);
    expect(await t.prisma.attendanceEvent.count({ where: { clientEventId: 'AFTER-REVOKE' } })).toBe(0);
    const history = await admin.get(`/devices/${d.deviceId}/sync-events`).expect(200);
    expect(history.body.data.some((e: { result: string }) => e.result === 'FAILED')).toBe(true);
  });

  it('a DECOMMISSIONED device is refused', async () => {
    const d = await provisionDevice(admin, anon, groupA, 'DEV-D');
    await admin.post(`/devices/${d.deviceId}/decommission`, { reason: 'Retired' }).expect(200);
    await anon.as(d.token).get('/sync/snapshot').expect(403);
    await anon.post('/sync/token', { deviceIdentifier: d.identifier, secret: d.secret }).expect(403);
  });

  it('credential rotation invalidates the old secret and every token issued with it', async () => {
    const d = await provisionDevice(admin, anon, groupA, 'DEV-ROT');
    const rot = await admin.post(`/devices/${d.deviceId}/credentials/rotate`).expect(200);
    const newSecret = rot.body.data.credentials.secret;
    expect(newSecret).not.toBe(d.secret);
    await anon.as(d.token).get('/sync/snapshot').expect(401);
    await anon.post('/sync/token', { deviceIdentifier: d.identifier, secret: d.secret }).expect(401);
    const fresh = await anon.post('/sync/token', { deviceIdentifier: d.identifier, secret: newSecret }).expect(200);
    await anon.as(fresh.body.data.accessToken).get('/sync/snapshot').expect(200);
  });

  it('secrets never appear in ordinary API responses', async () => {
    const d = await provisionDevice(admin, anon, groupA, 'DEV-X');
    const one = await admin.get(`/devices/${d.deviceId}`).expect(200);
    const list = await admin.get('/devices').expect(200);
    const text = JSON.stringify([one.body, list.body]);
    expect(text).not.toContain(d.secret);
    expect(text).not.toContain('secretHash');
  });

  it('device and user tokens are not interchangeable', async () => {
    const d = await provisionDevice(admin, anon, groupA, 'DEV-T');
    await anon.as(d.token).get('/members').expect(401);
    const userToken = await login(t, 'root@dti.test');
    await anon.as(userToken).get('/sync/snapshot').expect(401);
  });

  it("a device cannot use another group's sessions or see its roster", async () => {
    const dB = await provisionDevice(admin, anon, groupB, 'DEV-B');
    const snap = await anon.as(dB.token).get('/sync/snapshot').expect(200);
    expect(snap.body.data.group.id).toBe(groupB);
    expect(snap.body.data.roster).toEqual([]);
    expect(snap.body.data.sessions.map((s: { id: string }) => s.id)).not.toContain(sessionA);

    const up = await upload(dB.token, [tap('CROSS-1', sessionA), tap('CROSS-2')]).expect(200);
    expect(up.body.data.results.map((r: { reasonCode: string }) => r.reasonCode)).toEqual(['DEVICE_NOT_AUTHORIZED', 'NO_MATCHING_SESSION']);
    expect(await t.prisma.attendanceRecord.count()).toBe(0);
  });

  it('a CDS admin can manage devices of their own group only', async () => {
    await createUser(t.prisma, { email: 'cds-a@dti.test', role: 'CDS_ADMIN', groupIds: [groupA] });
    const cds = anon.as(await login(t, 'cds-a@dti.test'));
    const dB = await provisionDevice(admin, anon, groupB, 'DEV-B2');
    await cds.post(`/devices/${dB.deviceId}/revoke`, { reason: 'x' }).expect(404);
    await cds.post('/devices', { deviceIdentifier: 'DEV-A-OWN', name: 'Mine', assignedGroupId: groupA }).expect(201);
  });
});
