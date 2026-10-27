import { AccessScope } from '../../src/auth/access-scope';
import { ReportsService } from '../../src/reports/reports.service';
import { createTestApp, days, hours, resetDb, TestApp } from '../helpers/app';
import { Factory } from '../helpers/factory';

/**
 * Eligibility-based statistics, computed by the SQL in ReportsService.
 *
 * Timeline (weekly sessions, oldest first):
 *   S1–S10  CLOSED (held)
 *   S11     CANCELLED          → never counts
 *   S12     UNRESOLVED         → excluded, reported as a warning
 * Members:
 *   A  member since before S1   → eligible for S1–S10, attends S1–S8 (8/10 = 80 %)
 *   B  joins between S4 and S5  → eligible for S5–S10 only, attends S5–S9 (5/6 = 83.33 %, not 50 %)
 *   C  leaves between S6 and S7 → eligible for S1–S6, attends none (0/6)
 */
describe('Reports: eligibility, absence and attendance percentage', () => {
  let t: TestApp;
  let f: Factory;
  let reports: ReportsService;
  const scope = AccessScope.global();

  beforeAll(async () => {
    t = await createTestApp();
    f = new Factory(t.prisma);
    reports = t.app.get(ReportsService);
  });
  beforeEach(() => resetDb(t.prisma));
  afterAll(() => t.close());

  async function build() {
    const group = await f.group('Reporting group');
    const base = Date.now() - days(7 * 13);
    const at = (i: number) => new Date(base + days(7 * i)); // S1 = at(1) … S12 = at(12)
    const sessions = [];
    for (let i = 1; i <= 10; i++) sessions.push(await f.session(group.id, at(i), new Date(at(i).getTime() + hours(3)), 'CLOSED'));
    const cancelled = await f.session(group.id, at(11), new Date(at(11).getTime() + hours(3)), 'CANCELLED');
    const unresolved = await f.session(group.id, at(12), new Date(at(12).getTime() + hours(3)), 'UNRESOLVED');

    const A = await f.member(group.id, at(0), { name: 'A' });
    const B = await f.member(group.id, new Date(at(4).getTime() + days(3)), { name: 'B' });
    const C = await f.member(group.id, at(0), { name: 'C', leftAt: new Date(at(6).getTime() + days(3)) });

    const present = async (m: { member: { id: string }; membership: { id: string } }, s: { id: string; plannedStart: Date }) =>
      t.prisma.attendanceRecord.create({
        data: { sessionId: s.id, memberId: m.member.id, membershipId: m.membership.id, source: 'MANUAL', capturedAt: s.plannedStart },
      });
    for (let i = 0; i < 8; i++) await present(A, sessions[i]);
    for (let i = 4; i < 9; i++) await present(B, sessions[i]);
    await present(B, unresolved); // attendance attached to an unresolved meeting
    return { group, sessions, cancelled, unresolved, A, B, C };
  }

  it('a new member does not inherit earlier absences: 5 of 6 eligible sessions = 83.33 %', async () => {
    const { B } = await build();
    const r = await reports.memberReport(B.member.id, scope);
    expect(r.summary).toMatchObject({ eligibleSessions: 6, present: 5, absent: 1, attendanceRate: 83.33 });
    expect(r.sessions.find((s) => s.participation === 'PENDING_RESOLUTION')).toBeDefined();
    expect(r.sessions.some((s) => s.participation === 'CANCELLED')).toBe(true);
  });

  it('a member who left is not counted absent afterwards', async () => {
    const { A, C } = await build();
    expect((await reports.memberReport(A.member.id, scope)).summary).toMatchObject({ eligibleSessions: 10, present: 8, absent: 2, attendanceRate: 80 });
    expect((await reports.memberReport(C.member.id, scope)).summary).toMatchObject({ eligibleSessions: 6, present: 0, absent: 6, attendanceRate: 0 });
  });

  it('session report: eligible set changes over time, absent = eligible − present', async () => {
    const { sessions } = await build();
    const s1 = await reports.sessionReport(sessions[0].id, scope); // A, C eligible; A present
    expect(s1.summary).toMatchObject({ eligible: 2, present: 1, absent: 1, attendanceRate: 50, countsTowardStatistics: true });
    const s5 = await reports.sessionReport(sessions[4].id, scope); // A, B, C eligible; A, B present
    expect(s5.summary).toMatchObject({ eligible: 3, present: 2, absent: 1 });
    const s10 = await reports.sessionReport(sessions[9].id, scope); // A, B eligible (C left); none present
    expect(s10.summary).toMatchObject({ eligible: 2, present: 0, absent: 2 });
    expect(s10.members.map((m) => m.participation)).toEqual(['ABSENT', 'ABSENT']);
  });

  it('group report: cancelled sessions excluded, unresolved excluded with a warning, pooled rate', async () => {
    const { group } = await build();
    const r = await reports.groupReport(group.id, scope);
    // Eligible per held session: S1–S4: 2, S5–S6: 3, S7–S10: 2 → 8 + 6 + 8 = 22. Present: A 8 + B 5 = 13.
    expect(r.totals).toMatchObject({ heldSessions: 10, totalEligible: 22, totalPresent: 13, totalAbsent: 9, attendanceRate: 59.09 });
    expect(r.excluded).toMatchObject({ cancelled: 1, unresolved: 1 });
    expect(r.warnings.join(' ')).toMatch(/UNRESOLVED/);
    const unresolvedRow = r.sessions.find((s) => s.status === 'UNRESOLVED')!;
    expect(unresolvedRow).toMatchObject({ countsTowardStatistics: false, absent: null, attendanceRate: null, recordsAttached: 1 });
    const cancelledRow = r.sessions.find((s) => s.status === 'CANCELLED')!;
    expect(cancelledRow).toMatchObject({ countsTowardStatistics: false, present: 0, absent: null });
  });

  it('group member report lists per-member eligible sessions and rates', async () => {
    const { group } = await build();
    const r = await reports.groupMembersReport(group.id, scope);
    const byName = Object.fromEntries(r.members.map((m) => [m.fullName, m]));
    expect(byName.A).toMatchObject({ eligibleSessions: 10, present: 8, attendanceRate: 80 });
    expect(byName.B).toMatchObject({ eligibleSessions: 6, present: 5, attendanceRate: 83.33 });
    expect(byName.C).toMatchObject({ eligibleSessions: 6, present: 0, attendanceRate: 0 });
  });

  it('date ranges restrict the sessions considered', async () => {
    const { group, sessions } = await build();
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const r = await reports.groupReport(group.id, scope, iso(sessions[4].plannedStart), iso(sessions[5].plannedStart));
    expect(r.totals).toMatchObject({ heldSessions: 2, totalEligible: 6, totalPresent: 4 });
  });
});
