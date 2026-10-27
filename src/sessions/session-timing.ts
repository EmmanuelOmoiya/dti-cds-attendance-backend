import { HOUR_MS, MINUTE_MS } from '../common/time/dates';
import { AppConfig } from '../config/config.module';

/** Configurable timing rules for sessions (see .env: SESSION_*). */
export interface SessionTimingConfig {
  earlyGraceMinutes: number;
  closeGraceMinutes: number;
  unresolvedAfterHours: number;
}

export function timingFromConfig(c: AppConfig): SessionTimingConfig {
  return {
    earlyGraceMinutes: c.SESSION_EARLY_GRACE_MINUTES,
    closeGraceMinutes: c.SESSION_CLOSE_GRACE_MINUTES,
    unresolvedAfterHours: c.SESSION_UNRESOLVED_AFTER_HOURS,
  };
}

export interface SessionTimes {
  plannedStart: Date;
  plannedEnd: Date;
  openedAt: Date | null;
  closedAt: Date | null;
}

export interface AdmissionWindow {
  start: Date;
  end: Date;
}

/**
 * The period during which a tap counts for a session (judged on the tap's capturedAt, never
 * on upload time):
 *
 *   start = min(plannedStart − earlyGrace, openedAt)
 *   end   = closedAt                       if attendance was closed (manually or automatically)
 *         = plannedEnd + closeGrace        otherwise (the automatic close point)
 */
export function admissionWindow(s: SessionTimes, cfg: SessionTimingConfig): AdmissionWindow {
  const early = new Date(s.plannedStart.getTime() - cfg.earlyGraceMinutes * MINUTE_MS);
  const start = s.openedAt && s.openedAt < early ? s.openedAt : early;
  const end = s.closedAt ?? autoClosePoint(s, cfg);
  return { start, end };
}

export function autoClosePoint(s: Pick<SessionTimes, 'plannedEnd'>, cfg: SessionTimingConfig): Date {
  return new Date(s.plannedEnd.getTime() + cfg.closeGraceMinutes * MINUTE_MS);
}

export function unresolvedPoint(s: Pick<SessionTimes, 'plannedEnd'>, cfg: SessionTimingConfig): Date {
  return new Date(s.plannedEnd.getTime() + cfg.unresolvedAfterHours * HOUR_MS);
}

export function withinWindow(instant: Date, w: AdmissionWindow): boolean {
  return instant >= w.start && instant <= w.end;
}
