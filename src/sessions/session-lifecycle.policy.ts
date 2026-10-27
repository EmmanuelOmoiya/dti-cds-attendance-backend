import { AppError } from '../common/errors/app-error';
import { ErrorCode } from '../common/errors/error-codes';
import { SessionStatus } from '../generated/prisma/client';
import { autoClosePoint, SessionTimes, SessionTimingConfig, unresolvedPoint } from './session-timing';

/**
 * Session lifecycle rules (pure; no I/O).
 *
 *   SCHEDULED ──open──▶ OPEN ──close / auto-close──▶ CLOSED
 *   SCHEDULED | UNRESOLVED ──confirm-held──▶ CLOSED
 *   SCHEDULED | OPEN | UNRESOLVED | CLOSED ──cancel──▶ CANCELLED
 *   SCHEDULED ──(system, plannedEnd + 24h)──▶ UNRESOLVED
 *   CANCELLED ──reinstate──▶ SCHEDULED | UNRESOLVED
 *
 * "Held" (counts in reports) = CLOSED. A session is only ever held because an authorized person
 * opened it or confirmed it; device taps never confirm a meeting.
 */
export type SessionAction = 'open' | 'close' | 'confirm-held' | 'cancel' | 'reinstate' | 'edit';

export const ALLOWED_FROM: Record<SessionAction, readonly SessionStatus[]> = {
  open: [SessionStatus.SCHEDULED],
  close: [SessionStatus.OPEN],
  'confirm-held': [SessionStatus.SCHEDULED, SessionStatus.UNRESOLVED],
  cancel: [SessionStatus.SCHEDULED, SessionStatus.OPEN, SessionStatus.UNRESOLVED, SessionStatus.CLOSED],
  reinstate: [SessionStatus.CANCELLED],
  edit: [SessionStatus.SCHEDULED],
};

type S = SessionTimes & { status: SessionStatus };

function assertFrom(s: S, action: SessionAction): void {
  if (!ALLOWED_FROM[action].includes(s.status)) throw AppError.transition('session', s.status, action);
}

/** Opening means "the meeting is happening now". Only around the planned time. */
export function assertCanOpen(s: S, now: Date, cfg: SessionTimingConfig): void {
  assertFrom(s, 'open');
  const earliest = new Date(s.plannedStart.getTime() - cfg.earlyGraceMinutes * 60_000);
  const latest = autoClosePoint(s, cfg);
  if (now < earliest || now > latest) {
    throw AppError.rule(
      ErrorCode.SESSION_OPEN_OUT_OF_RANGE,
      'A session can only be opened around its planned time; use confirm-held for a past meeting',
      { earliest, latest },
    );
  }
}

export function assertCanClose(s: S): void {
  assertFrom(s, 'close');
}

/** Retrospective confirmation is for meetings that are over. */
export function assertCanConfirmHeld(s: S, now: Date): void {
  assertFrom(s, 'confirm-held');
  if (now < s.plannedEnd) {
    throw AppError.rule(ErrorCode.SESSION_NOT_ENDED, 'The meeting has not ended yet; open the session instead');
  }
}

export function assertCanCancel(s: S, note: string | undefined): void {
  assertFrom(s, 'cancel');
  if (s.status === SessionStatus.CLOSED && !note?.trim()) {
    throw AppError.rule(ErrorCode.NOTE_REQUIRED, 'A note is required to cancel a session that was confirmed held');
  }
}

export function assertCanReinstate(s: S): void {
  assertFrom(s, 'reinstate');
}

export function assertEditable(s: S): void {
  if (!ALLOWED_FROM.edit.includes(s.status)) {
    throw AppError.conflict(ErrorCode.SESSION_NOT_EDITABLE, `Only SCHEDULED sessions can be edited (status is ${s.status})`);
  }
}

/** A reinstated session returns to "unknown": SCHEDULED, or UNRESOLVED if its resolution deadline passed. */
export function statusAfterReinstate(s: SessionTimes, now: Date, cfg: SessionTimingConfig): SessionStatus {
  return now > unresolvedPoint(s, cfg) ? SessionStatus.UNRESOLVED : SessionStatus.SCHEDULED;
}

/** Initial status for a newly generated/created session (back-filled past occurrences start UNRESOLVED). */
export function initialStatus(s: SessionTimes, now: Date, cfg: SessionTimingConfig): SessionStatus {
  return statusAfterReinstate(s, now, cfg);
}

export function shouldMarkUnresolved(s: S, now: Date, cfg: SessionTimingConfig): boolean {
  return s.status === SessionStatus.SCHEDULED && now > unresolvedPoint(s, cfg);
}

export function shouldAutoClose(s: S, now: Date, cfg: SessionTimingConfig): boolean {
  return s.status === SessionStatus.OPEN && now > autoClosePoint(s, cfg);
}

/** closedAt used by auto-close: the deterministic close point (never before openedAt). */
export function autoCloseAt(s: SessionTimes, cfg: SessionTimingConfig): Date {
  const point = autoClosePoint(s, cfg);
  if (s.openedAt && point <= s.openedAt) return new Date(s.openedAt.getTime() + 1);
  return point;
}
