import { eligibilityFor, membershipCovers, MembershipPeriod } from '../../src/members/eligibility';

const T = (iso: string) => new Date(iso);
const G = 'group-a';
const sessionStart = T('2026-11-10T10:00:00+01:00');

const m = (joinedAt: string, leftAt: string | null = null, groupId = G, id = 'ms'): MembershipPeriod => ({
  id,
  groupId,
  joinedAt: T(joinedAt),
  leftAt: leftAt ? T(leftAt) : null,
});

describe('membership eligibility (joinedAt <= start AND (leftAt IS NULL OR leftAt > start))', () => {
  it('member who joined at 08:00 is eligible for the 10:00 meeting the same day', () => {
    expect(eligibilityFor([m('2026-11-10T08:00:00+01:00')], G, sessionStart)).toEqual({ eligible: true, membershipId: 'ms' });
  });

  it('member who joined at 14:00 is NOT eligible for the 10:00 meeting', () => {
    expect(eligibilityFor([m('2026-11-10T14:00:00+01:00')], G, sessionStart)).toEqual({ eligible: false, reason: 'NOT_YET_MEMBER' });
  });

  it('joining exactly at the session start counts as eligible', () => {
    expect(eligibilityFor([m('2026-11-10T10:00:00+01:00')], G, sessionStart).eligible).toBe(true);
  });

  it('leaving exactly at the session start is NOT eligible (half-open period)', () => {
    expect(eligibilityFor([m('2026-01-01T00:00:00Z', '2026-11-10T10:00:00+01:00')], G, sessionStart)).toEqual({ eligible: false, reason: 'MEMBERSHIP_ENDED' });
  });

  it('leaving one millisecond after the start is still eligible', () => {
    expect(eligibilityFor([m('2026-01-01T00:00:00Z', '2026-11-10T09:00:00.001Z')], G, sessionStart).eligible).toBe(true);
  });

  it('membership in another group does not count', () => {
    expect(eligibilityFor([m('2026-01-01T00:00:00Z', null, 'group-b')], G, sessionStart)).toEqual({ eligible: false, reason: 'NOT_IN_GROUP' });
  });

  it('transfer: old group eligible before the move, new group after', () => {
    const history = [m('2026-01-01T00:00:00Z', '2026-11-01T00:00:00Z', G, 'old'), m('2026-11-01T00:00:00Z', null, 'group-b', 'new')];
    expect(eligibilityFor(history, G, T('2026-10-20T10:00:00Z'))).toEqual({ eligible: true, membershipId: 'old' });
    expect(eligibilityFor(history, G, sessionStart)).toEqual({ eligible: false, reason: 'MEMBERSHIP_ENDED' });
    expect(eligibilityFor(history, 'group-b', sessionStart)).toEqual({ eligible: true, membershipId: 'new' });
  });

  it('re-joining after a gap: eligible in both periods, not in the gap', () => {
    const history = [m('2026-01-01T00:00:00Z', '2026-03-01T00:00:00Z', G, 'first'), m('2026-06-01T00:00:00Z', null, G, 'second')];
    expect(eligibilityFor(history, G, T('2026-02-01T10:00:00Z'))).toMatchObject({ membershipId: 'first' });
    expect(eligibilityFor(history, G, T('2026-04-01T10:00:00Z'))).toMatchObject({ eligible: false });
    expect(eligibilityFor(history, G, T('2026-07-01T10:00:00Z'))).toMatchObject({ membershipId: 'second' });
  });

  it('membershipCovers matches the same rule', () => {
    expect(membershipCovers({ joinedAt: T('2026-01-01T00:00:00Z'), leftAt: null }, sessionStart)).toBe(true);
    expect(membershipCovers({ joinedAt: sessionStart, leftAt: sessionStart }, sessionStart)).toBe(false);
  });
});
