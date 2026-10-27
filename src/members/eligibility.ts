/**
 * Membership eligibility (pure).
 *
 * A membership is valid over the half-open interval [joinedAt, leftAt). A member is eligible
 * for a session of group G when some membership in G satisfies
 *
 *     joinedAt <= session.plannedStart  AND  (leftAt IS NULL OR leftAt > session.plannedStart)
 *
 * The same rule is implemented in SQL by the report queries (reports.service.ts); the unit and
 * integration tests check both agree.
 */
export interface MembershipPeriod {
  id: string;
  groupId: string;
  joinedAt: Date;
  leftAt: Date | null;
}

export function membershipCovers(m: Pick<MembershipPeriod, 'joinedAt' | 'leftAt'>, instant: Date): boolean {
  return m.joinedAt <= instant && (m.leftAt === null || m.leftAt > instant);
}

export type Eligibility =
  | { eligible: true; membershipId: string }
  | { eligible: false; reason: 'NOT_YET_MEMBER' | 'MEMBERSHIP_ENDED' | 'NOT_IN_GROUP' };

/** Eligibility of one member for a session of `groupId` starting at `sessionStart`. */
export function eligibilityFor(memberships: readonly MembershipPeriod[], groupId: string, sessionStart: Date): Eligibility {
  const inGroup = memberships.filter((m) => m.groupId === groupId);
  const covering = inGroup.find((m) => membershipCovers(m, sessionStart));
  if (covering) return { eligible: true, membershipId: covering.id };
  if (inGroup.length === 0) return { eligible: false, reason: 'NOT_IN_GROUP' };
  // Prefer "ended" when a past membership exists; otherwise every membership starts later.
  const endedBefore = inGroup.some((m) => m.leftAt !== null && m.leftAt <= sessionStart);
  return { eligible: false, reason: endedBefore ? 'MEMBERSHIP_ENDED' : 'NOT_YET_MEMBER' };
}
