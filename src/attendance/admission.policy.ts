import { CardStatus, MemberStatus, RejectReason, SessionStatus } from '../generated/prisma/client';
import { eligibilityFor, MembershipPeriod } from '../members/eligibility';
import { admissionWindow, SessionTimes, SessionTimingConfig, withinWindow } from '../sessions/session-timing';

/**
 * Attendance admission policy — the business rules that decide whether a tap becomes an
 * official attendance record. Pure: every fact is loaded beforehand (AttendanceIngestionService),
 * so the rules can be unit-tested exhaustively without a database.
 *
 * Every time-dependent rule is evaluated at the tap's `capturedAt`, never at upload time.
 */

export interface SessionCandidate extends SessionTimes {
  id: string;
  groupId: string;
  status: SessionStatus;
}

export type SessionResolution =
  | { kind: 'FOUND'; session: SessionCandidate; reassigned: boolean }
  | { kind: 'OTHER_GROUP'; sessionId: string }
  | { kind: 'CANCELLED'; sessionId: string }
  | { kind: 'NONE' };

/**
 * Which session a tap belongs to.
 *  1. A claimed (device-supplied) session of the device's group that is not cancelled is used as-is
 *     (its window is checked later, giving SESSION_NOT_OPEN when the tap falls outside it).
 *  2. Otherwise — no claim, unknown id, or a claim on a cancelled session (e.g. replaced by a
 *     reschedule) — the non-cancelled session of the device's group whose admission window contains
 *     capturedAt is used; the nearest plannedStart wins if windows overlap.
 *  3. Nothing matches → CANCELLED if the tap falls in a cancelled session (or claimed one), else NONE.
 */
export function resolveSession(
  claimed: SessionCandidate | null,
  candidates: readonly SessionCandidate[],
  deviceGroupId: string,
  capturedAt: Date,
  cfg: SessionTimingConfig,
): SessionResolution {
  if (claimed) {
    if (claimed.groupId !== deviceGroupId) return { kind: 'OTHER_GROUP', sessionId: claimed.id };
    if (claimed.status !== SessionStatus.CANCELLED) return { kind: 'FOUND', session: claimed, reassigned: false };
  }
  const containing = candidates
    .filter((s) => s.groupId === deviceGroupId && withinWindow(capturedAt, admissionWindow(s, cfg)))
    .sort((a, b) => Math.abs(a.plannedStart.getTime() - capturedAt.getTime()) - Math.abs(b.plannedStart.getTime() - capturedAt.getTime()));
  const live = containing.find((s) => s.status !== SessionStatus.CANCELLED);
  if (live) return { kind: 'FOUND', session: live, reassigned: claimed !== null };
  if (claimed) return { kind: 'CANCELLED', sessionId: claimed.id };
  const cancelled = containing.find((s) => s.status === SessionStatus.CANCELLED);
  if (cancelled) return { kind: 'CANCELLED', sessionId: cancelled.id };
  return { kind: 'NONE' };
}

export interface AdmissionFacts {
  capturedAt: Date;
  /** Server time the event was received (reference for the "not in the future" check). */
  receivedAt: Date;
  minCaptureDate: Date;
  futureToleranceMs: number;

  card: { id: string; status: CardStatus } | null;
  /** The assignment whose [assignedAt, endedAt) contains capturedAt, if any. */
  assignmentAtCapture: { id: string; memberId: string } | null;
  /** True if the card had an assignment that ended at or before capturedAt. */
  cardAssignmentEndedBeforeCapture: boolean;

  member: { id: string; status: MemberStatus; deactivatedAt: Date | null } | null;
  session: SessionResolution;
  /** The member's memberships (any group). */
  memberships: readonly MembershipPeriod[];
}

export type AdmissionDecision =
  | {
      decision: 'ACCEPT';
      sessionId: string;
      memberId: string;
      membershipId: string;
      cardId: string;
      cardAssignmentId: string;
      lateSync: boolean;
      sessionReassigned: boolean;
    }
  | {
      decision: 'REJECT';
      reason: RejectReason;
      /** Whatever was resolved before the rejecting rule, for the event record. */
      sessionId?: string;
      memberId?: string;
      cardId?: string;
      cardAssignmentId?: string;
    };

export function evaluateAdmission(f: AdmissionFacts, cfg: SessionTimingConfig): AdmissionDecision {
  // R1 — plausible capture time (a reset device clock produces 1970/2000 timestamps).
  if (f.capturedAt < f.minCaptureDate || f.capturedAt.getTime() > f.receivedAt.getTime() + f.futureToleranceMs) {
    return { decision: 'REJECT', reason: RejectReason.INVALID_TIMESTAMP };
  }

  // R2 — the card must be registered.
  if (!f.card) return { decision: 'REJECT', reason: RejectReason.UNKNOWN_CARD };
  const cardId = f.card.id;

  // R3 — the card must have been assigned to someone at the moment of the tap.
  if (!f.assignmentAtCapture) {
    const revoked = f.card.status === CardStatus.REVOKED || f.cardAssignmentEndedBeforeCapture;
    return { decision: 'REJECT', reason: revoked ? RejectReason.CARD_REVOKED : RejectReason.CARD_NOT_ASSIGNED, cardId };
  }
  const cardAssignmentId = f.assignmentAtCapture.id;
  const memberId = f.assignmentAtCapture.memberId;

  // R4 — the member must not have been deactivated at the time of the tap.
  if (!f.member || (f.member.status === MemberStatus.INACTIVE && (!f.member.deactivatedAt || f.member.deactivatedAt <= f.capturedAt))) {
    return { decision: 'REJECT', reason: RejectReason.MEMBER_INACTIVE, cardId, cardAssignmentId, memberId };
  }

  // R5 — a valid session of the device's own group.
  const ids = { cardId, cardAssignmentId, memberId };
  switch (f.session.kind) {
    case 'OTHER_GROUP':
      return { decision: 'REJECT', reason: RejectReason.DEVICE_NOT_AUTHORIZED, ...ids };
    case 'CANCELLED':
      return { decision: 'REJECT', reason: RejectReason.SESSION_CANCELLED, sessionId: f.session.sessionId, ...ids };
    case 'NONE':
      return { decision: 'REJECT', reason: RejectReason.NO_MATCHING_SESSION, ...ids };
  }
  const session = f.session.session;

  // R6 — the tap happened while attendance for that session was open.
  const window = admissionWindow(session, cfg);
  if (!withinWindow(f.capturedAt, window)) {
    return { decision: 'REJECT', reason: RejectReason.SESSION_NOT_OPEN, sessionId: session.id, ...ids };
  }

  // R7 — the member belonged to the session's group when the session started.
  const eligibility = eligibilityFor(f.memberships, session.groupId, session.plannedStart);
  if (!eligibility.eligible) {
    const reason = eligibility.reason === 'NOT_IN_GROUP' ? RejectReason.MEMBER_NOT_IN_GROUP : RejectReason.NOT_ELIGIBLE_FOR_SESSION;
    return { decision: 'REJECT', reason, sessionId: session.id, ...ids };
  }

  // R8 (one record per member per session) is enforced by the database at insert time.
  return {
    decision: 'ACCEPT',
    sessionId: session.id,
    memberId,
    membershipId: eligibility.membershipId,
    cardId,
    cardAssignmentId,
    lateSync: f.receivedAt > window.end,
    sessionReassigned: f.session.reassigned,
  };
}
