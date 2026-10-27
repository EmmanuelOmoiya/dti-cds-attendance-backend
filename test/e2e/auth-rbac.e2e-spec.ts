import { createTestApp, createUser, login, resetDb, TEST_PASSWORD, TestApp } from '../helpers/app';
import { Api } from '../helpers/api';

describe('Authentication and RBAC (HTTP)', () => {
  let t: TestApp;
  let anon: Api;
  let superAdmin: Api;
  let groupA: string;
  let groupB: string;

  beforeAll(async () => {
    t = await createTestApp();
    anon = new Api(t);
  });
  afterAll(() => t.close());

  beforeEach(async () => {
    await resetDb(t.prisma);
    await createUser(t.prisma, { email: 'root@dti.test', role: 'SUPER_ADMIN' });
    superAdmin = anon.as(await login(t, 'root@dti.test'));
    groupA = (await superAdmin.post('/groups', { name: 'Group A' }).expect(201)).body.data.id;
    groupB = (await superAdmin.post('/groups', { name: 'Group B' }).expect(201)).body.data.id;
  });

  describe('login', () => {
    it('valid credentials return an access and refresh token', async () => {
      const res = await anon.post('/auth/login', { email: 'ROOT@dti.test', password: TEST_PASSWORD }).expect(200);
      expect(res.body.data).toMatchObject({ tokenType: 'Bearer', accessTokenExpiresIn: 900 });
      expect(res.body.data.refreshToken).toMatch(/^rt_/);
      const me = await anon.as(res.body.data.accessToken).get('/auth/me').expect(200);
      expect(me.body.data).toMatchObject({ email: 'root@dti.test', role: 'SUPER_ADMIN' });
      expect(me.body.data.passwordHash).toBeUndefined();
    });

    it('invalid password and unknown email give the same generic 401, and are audited', async () => {
      const a = await anon.post('/auth/login', { email: 'root@dti.test', password: 'wrong-password' }).expect(401);
      const b = await anon.post('/auth/login', { email: 'nobody@dti.test', password: 'wrong-password' }).expect(401);
      expect(a.body.error.code).toBe('INVALID_CREDENTIALS');
      expect(b.body.error).toMatchObject({ code: 'INVALID_CREDENTIALS', message: a.body.error.message });
      expect(a.body.error.requestId).toBeDefined();
      const audits = await t.prisma.auditLog.findMany({ where: { action: 'auth.login.failed' } });
      expect(audits).toHaveLength(2);
      expect(JSON.stringify(audits.map((a) => a.metadata))).not.toContain('wrong-password');
    });

    it('a disabled user cannot log in, and their existing token stops working immediately', async () => {
      const u = await createUser(t.prisma, { email: 'cds@dti.test', role: 'CDS_ADMIN', groupIds: [groupA] });
      const token = await login(t, 'cds@dti.test');
      await superAdmin.post(`/users/${u.id}/disable`).expect(200);
      await anon.post('/auth/login', { email: 'cds@dti.test', password: TEST_PASSWORD }).expect(403);
      await anon.as(token).get('/auth/me').expect(401);
    });

    it('missing or malformed tokens are rejected', async () => {
      await anon.get('/members').expect(401);
      await anon.as('not-a-jwt').get('/members').expect(401);
    });

    it('validation errors use the standard error shape', async () => {
      const res = await anon.post('/auth/login', { email: 'not-an-email', password: '' }).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(res.body.error.details.map((d: { field: string }) => d.field).sort()).toEqual(['email', 'password']);
      const extra = await anon.post('/auth/login', { email: 'a@b.co', password: 'x', isAdmin: true }).expect(400);
      expect(extra.body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('refresh tokens', () => {
    it('rotate on use; re-using an old refresh token revokes the whole session family', async () => {
      const first = (await anon.post('/auth/login', { email: 'root@dti.test', password: TEST_PASSWORD }).expect(200)).body.data;
      const second = (await anon.post('/auth/refresh', { refreshToken: first.refreshToken }).expect(200)).body.data;
      expect(second.refreshToken).not.toBe(first.refreshToken);
      await anon.post('/auth/refresh', { refreshToken: first.refreshToken }).expect(401); // reuse → family revoked
      await anon.post('/auth/refresh', { refreshToken: second.refreshToken }).expect(401);
      expect(await t.prisma.auditLog.count({ where: { action: 'auth.refresh.reuse_detected' } })).toBe(1);
    });

    it('logout revokes the refresh token', async () => {
      const tokens = (await anon.post('/auth/login', { email: 'root@dti.test', password: TEST_PASSWORD }).expect(200)).body.data;
      await anon.as(tokens.accessToken).post('/auth/logout', { refreshToken: tokens.refreshToken }).expect(204);
      await anon.post('/auth/refresh', { refreshToken: tokens.refreshToken }).expect(401);
    });
  });

  describe('role restrictions and group scope', () => {
    let cdsA: Api;
    let lgiA: Api;

    beforeEach(async () => {
      await createUser(t.prisma, { email: 'cds-a@dti.test', role: 'CDS_ADMIN', groupIds: [groupA] });
      await createUser(t.prisma, { email: 'lgi-a@dti.test', role: 'LGI_VIEWER', groupIds: [groupA] });
      cdsA = anon.as(await login(t, 'cds-a@dti.test'));
      lgiA = anon.as(await login(t, 'lgi-a@dti.test'));
    });

    it('only SUPER_ADMIN manages users and creates groups', async () => {
      await cdsA.get('/users').expect(403);
      await cdsA.post('/groups', { name: 'Mine' }).expect(403);
      await lgiA.post('/users', { email: 'x@y.zz', fullName: 'X', role: 'LGI_VIEWER', password: 'long-enough-1' }).expect(403);
      await superAdmin.post('/users', { email: 'new@dti.test', fullName: 'New', role: 'LGI_VIEWER', password: 'long-enough-1', groupIds: [groupB] }).expect(201);
    });

    it('LGI_VIEWER can read but not mutate', async () => {
      await lgiA.get(`/groups/${groupA}`).expect(200);
      await lgiA.get(`/reports/groups/${groupA}`).expect(200);
      await lgiA.post('/members', { fullName: 'Ada', stateCode: 'LA/25A/0001', groupId: groupA }).expect(403);
      await lgiA.post('/cards', { cardUid: '04AABBCCDD' }).expect(403);
      await lgiA.post('/sessions', { groupId: groupA, title: 'X', plannedStart: '2030-01-01T09:00:00Z', plannedEnd: '2030-01-01T10:00:00Z' }).expect(403);
      await lgiA.get('/devices').expect(403);
    });

    it('CDS_ADMIN manages its own group and cannot see or touch another group (404)', async () => {
      const own = await cdsA.post('/members', { fullName: 'Ada', stateCode: 'LA/25A/0001', groupId: groupA }).expect(201);
      expect(own.body.data.currentGroup.id).toBe(groupA);
      await cdsA.post('/members', { fullName: 'Bola', stateCode: 'LA/25A/0002', groupId: groupB }).expect(404);

      const other = await superAdmin.post('/members', { fullName: 'Chi', stateCode: 'LA/25A/0003', groupId: groupB }).expect(201);
      await cdsA.get(`/members/${other.body.data.id}`).expect(404);
      await cdsA.get(`/groups/${groupB}`).expect(404);
      await cdsA.get(`/reports/groups/${groupB}`).expect(404);
      await cdsA.post('/devices', { deviceIdentifier: 'DEV-B-1', name: 'B reader', assignedGroupId: groupB }).expect(404);

      const list = await cdsA.get('/members').expect(200);
      expect(list.body.data.map((m: { id: string }) => m.id)).toEqual([own.body.data.id]);
      const groups = await cdsA.get('/groups').expect(200);
      expect(groups.body.data.map((g: { id: string }) => g.id)).toEqual([groupA]);
    });

    it('removing a group scope takes effect on the next request', async () => {
      const cds = await t.prisma.user.findUniqueOrThrow({ where: { email: 'cds-a@dti.test' } });
      await cdsA.get(`/groups/${groupA}`).expect(200);
      await superAdmin.put(`/users/${cds.id}/group-scopes`, { groupIds: [] }).expect(200);
      await cdsA.get(`/groups/${groupA}`).expect(404);
    });

    it('user administration actions are audited without secrets', async () => {
      const created = await superAdmin.post('/users', { email: 'z@dti.test', fullName: 'Zed', role: 'CDS_ADMIN', password: 'super-secret-pw', groupIds: [groupA] }).expect(201);
      await superAdmin.post(`/users/${created.body.data.id}/reset-password`, { newPassword: 'another-secret-pw' }).expect(204);
      const rows = await t.prisma.auditLog.findMany({ where: { entityId: created.body.data.id } });
      expect(rows.map((r) => r.action).sort()).toEqual(['user.created', 'user.password_reset']);
      expect(JSON.stringify(rows.map((r) => r.metadata))).not.toMatch(/super-secret-pw|another-secret-pw/);
    });
  });
});
