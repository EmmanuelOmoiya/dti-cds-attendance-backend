import { createTestApp, createUser, login, resetDb, TestApp } from '../helpers/app';
import { Api } from '../helpers/api';

const DAY = 86_400_000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

describe('Membership lifecycle and card management (HTTP)', () => {
  let t: TestApp;
  let anon: Api;
  let admin: Api;
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
    admin = anon.as(await login(t, 'root@dti.test'));
    groupA = (await admin.post('/groups', { name: 'Group A' }).expect(201)).body.data.id;
    groupB = (await admin.post('/groups', { name: 'Group B' }).expect(201)).body.data.id;
  });

  const newMember = async (stateCode = 'LA/25A/0001', groupId = groupA, joinedAgo = 60 * DAY) =>
    (await admin.post('/members', { fullName: 'Ada Obi', stateCode, groupId, joinedAt: iso(joinedAgo) }).expect(201)).body.data;

  describe('memberships', () => {
    it('a member joins a group (membership created atomically with the member)', async () => {
      const m = await newMember();
      expect(m.currentGroup).toMatchObject({ id: groupA });
      expect(m.memberships).toHaveLength(1);
      expect(m.memberships[0]).toMatchObject({ groupId: groupA, status: 'ACTIVE', leftAt: null });
      await admin.post('/members', { fullName: 'Dup', stateCode: 'la/25a/0001', groupId: groupA }).expect(409);
    });

    it('a member leaves (completes service); history is preserved and they drop out of the current roster', async () => {
      const m = await newMember();
      const ended = await admin.post(`/memberships/${m.memberships[0].id}/end`, { leftAt: iso(DAY), reason: 'SERVICE_COMPLETED' }).expect(200);
      expect(ended.body.data).toMatchObject({ status: 'ENDED', endReason: 'SERVICE_COMPLETED' });
      const current = await admin.get(`/members?groupId=${groupA}`).expect(200);
      expect(current.body.data).toHaveLength(0);
      const any = await admin.get(`/members?groupId=${groupA}&membership=any`).expect(200);
      expect(any.body.data).toHaveLength(1);
      const history = await admin.get(`/members/${m.id}/memberships`).expect(200);
      expect(history.body.data).toHaveLength(1);
    });

    it('a member transfers: old membership ends, new one starts at the same instant, both kept and linked', async () => {
      const m = await newMember();
      const at = iso(7 * DAY);
      const res = await admin.post(`/members/${m.id}/transfer`, { toGroupId: groupB, effectiveAt: at }).expect(200);
      expect(res.body.data.currentGroup.id).toBe(groupB);
      const [newer, older] = res.body.data.memberships;
      expect(older).toMatchObject({ groupId: groupA, endReason: 'TRANSFERRED', leftAt: at, transferredToMembershipId: newer.id, status: 'ENDED' });
      expect(newer).toMatchObject({ groupId: groupB, joinedAt: at, status: 'ACTIVE' });
      expect(await t.prisma.auditLog.count({ where: { action: 'member.transferred' } })).toBe(2);
    });

    it('overlapping memberships are refused (409); re-joining after a gap is allowed', async () => {
      const m = await newMember();
      await admin.post('/memberships', { memberId: m.id, groupId: groupB, joinedAt: iso(10 * DAY) }).expect(409);
      await admin.post(`/memberships/${m.memberships[0].id}/end`, { leftAt: iso(20 * DAY), reason: 'OTHER' }).expect(200);
      const rejoin = await admin.post('/memberships', { memberId: m.id, groupId: groupA, joinedAt: iso(5 * DAY) }).expect(201);
      expect(rejoin.body.data.status).toBe('ACTIVE');
      expect((await admin.get(`/memberships?memberId=${m.id}`).expect(200)).body.meta.total).toBe(2);
    });

    it('a membership correction that would strand attendance outside the period is refused', async () => {
      const m = await newMember();
      const s = await admin.post('/sessions', { groupId: groupA, title: 'Past', plannedStart: iso(3 * DAY), plannedEnd: iso(3 * DAY - 7_200_000) }).expect(201);
      await admin.post(`/sessions/${s.body.data.id}/confirm-held`, {}).expect(200);
      await admin.post('/attendance', { sessionId: s.body.data.id, memberId: m.id, note: 'Signed paper register' }).expect(201);
      const res = await admin.patch(`/memberships/${m.memberships[0].id}`, { joinedAt: iso(2 * DAY), note: 'Data entry fix' }).expect(409);
      expect(res.body.error.code).toBe('MEMBERSHIP_HAS_ATTENDANCE');
      const corrected = iso(50 * DAY);
      const ok = await admin.patch(`/memberships/${m.memberships[0].id}`, { joinedAt: corrected, note: 'Actual posting date' }).expect(200);
      expect(ok.body.data.joinedAt).toBe(corrected);
      expect(await t.prisma.auditLog.count({ where: { action: 'membership.corrected' } })).toBe(1);
    });

    it('deactivating a member ends their membership and card assignment; history remains', async () => {
      const m = await newMember();
      await admin.post('/card-assignments', { cardUid: '04AA11BB22CC33', memberId: m.id }).expect(201);
      const res = await admin.post(`/members/${m.id}/deactivate`, { note: 'Passed out' }).expect(200);
      expect(res.body.data).toMatchObject({ status: 'INACTIVE', currentGroup: null, activeCard: null });
      expect(res.body.data.memberships[0]).toMatchObject({ endReason: 'MEMBER_DEACTIVATED', status: 'ENDED' });
      const card = await admin.get('/cards/history?cardUid=04AA11BB22CC33').expect(200);
      expect(card.body.data).toMatchObject({ status: 'UNASSIGNED' });
      expect(card.body.data.assignments[0]).toMatchObject({ status: 'ENDED', endReason: 'MEMBER_LEFT' });
    });
  });

  describe('cards', () => {
    it('register, assign, and enforce one holder per card and one active card per member', async () => {
      const a = await newMember('LA/25A/0001');
      const b = await newMember('LA/25A/0002');
      const card = (await admin.post('/cards', { cardUid: '04:a1:b2:c3:d4:e5:f6' }).expect(201)).body.data;
      expect(card).toMatchObject({ cardUid: '04A1B2C3D4E5F6', status: 'UNASSIGNED' });
      await admin.post('/cards', { cardUid: '04A1B2C3D4E5F6' }).expect(409);

      const asg = await admin.post('/card-assignments', { cardId: card.id, memberId: a.id }).expect(201);
      expect(asg.body.data).toMatchObject({ status: 'ACTIVE', memberId: a.id });
      const dupCard = await admin.post('/card-assignments', { cardId: card.id, memberId: b.id }).expect(409);
      expect(dupCard.body.error.code).toBe('CARD_ALREADY_ASSIGNED');
      const second = await admin.post('/card-assignments', { cardUid: '04FFFFFFFFFF01', memberId: a.id }).expect(409);
      expect(second.body.error.code).toBe('MEMBER_HAS_ACTIVE_CARD');
    });

    it('replacement keeps the old assignment with its validity period and links it to the new one', async () => {
      const a = await newMember();
      const first = (await admin.post('/card-assignments', { cardUid: '04000000000001', memberId: a.id }).expect(201)).body.data;
      const rep = await admin.post(`/members/${a.id}/card-replacement`, { newCardUid: '04000000000002', reason: 'LOST', note: 'Lost at camp' }).expect(201);
      expect(rep.body.data.previousAssignmentId).toBe(first.id);

      const history = await admin.get(`/members/${a.id}/card-assignments`).expect(200);
      const [current, old] = history.body.data;
      expect(old).toMatchObject({ id: first.id, status: 'ENDED', endReason: 'REPLACED', replacedByAssignmentId: current.id, assignedAt: first.assignedAt });
      expect(current).toMatchObject({ status: 'ACTIVE', assignedAt: old.endedAt });
      expect(current.card.cardUid).toBe('04000000000002');
      const oldCard = await admin.get('/cards/history?cardUid=04000000000001').expect(200);
      expect(oldCard.body.data).toMatchObject({ status: 'REVOKED', revokeReason: 'LOST' });
    });

    it('revocation ends the assignment; a revoked card cannot be assigned until reinstated; reuse keeps history', async () => {
      const a = await newMember('LA/25A/0001');
      const b = await newMember('LA/25A/0002');
      const asg = (await admin.post('/card-assignments', { cardUid: '04000000000009', memberId: a.id }).expect(201)).body.data;
      await admin.post(`/cards/${asg.cardId}/revoke`, { reason: 'DAMAGED' }).expect(200);
      const blocked = await admin.post('/card-assignments', { cardId: asg.cardId, memberId: b.id }).expect(422);
      expect(blocked.body.error.code).toBe('CARD_NOT_ASSIGNABLE');
      await admin.post(`/cards/${asg.cardId}/reinstate`).expect(200);
      await admin.post('/card-assignments', { cardId: asg.cardId, memberId: b.id }).expect(201);
      const card = await admin.get(`/cards/${asg.cardId}`).expect(200);
      expect(card.body.data.assignments.map((x: { memberId: string; status: string }) => [x.memberId, x.status])).toEqual([
        [b.id, 'ACTIVE'],
        [a.id, 'ENDED'],
      ]);
    });

    it('malformed card UIDs are rejected', async () => {
      const res = await admin.post('/cards', { cardUid: 'not-hex-at-all' }).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('card actions are audited', async () => {
      const a = await newMember();
      await admin.post('/card-assignments', { cardUid: '04000000000011', memberId: a.id }).expect(201);
      await admin.post(`/members/${a.id}/card-replacement`, { newCardUid: '04000000000012', reason: 'DAMAGED' }).expect(201);
      const actions = (await t.prisma.auditLog.findMany({ where: { action: { startsWith: 'card' } } })).map((r) => r.action);
      expect(actions).toEqual(expect.arrayContaining(['card.registered', 'card.assigned', 'card.replaced']));
    });
  });
});
