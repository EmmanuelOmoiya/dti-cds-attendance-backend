import { AppError } from '../../src/common/errors/app-error';
import { SessionStatus } from '../../src/generated/prisma/client';
import * as policy from '../../src/sessions/session-lifecycle.policy';
import { admissionWindow, SessionTimingConfig } from '../../src/sessions/session-timing';

const cfg: SessionTimingConfig = { earlyGraceMinutes: 60, closeGraceMinutes: 30, unresolvedAfterHours: 24 };
const T = (iso: string) => new Date(iso);
const base = { plannedStart: T('2026-11-13T09:00:00Z'), plannedEnd: T('2026-11-13T12:00:00Z'), openedAt: null as Date | null, closedAt: null as Date | null };
const s = (status: SessionStatus, over: Partial<typeof base> = {}) => ({ ...base, status, ...over });

const codeOf = (fn: () => void): string | undefined => {
  try {
    fn();
    return undefined;
  } catch (e) {
    return (e as AppError).code;
  }
};

describe('session lifecycle policy', () => {
  it('only SCHEDULED sessions can be opened, and only around the planned time', () => {
    expect(codeOf(() => policy.assertCanOpen(s(SessionStatus.SCHEDULED), T('2026-11-13T09:05:00Z'), cfg))).toBeUndefined();
    expect(codeOf(() => policy.assertCanOpen(s(SessionStatus.SCHEDULED), T('2026-11-13T07:00:00Z'), cfg))).toBe('SESSION_OPEN_OUT_OF_RANGE');
    expect(codeOf(() => policy.assertCanOpen(s(SessionStatus.SCHEDULED), T('2026-11-14T09:00:00Z'), cfg))).toBe('SESSION_OPEN_OUT_OF_RANGE');
    for (const st of [SessionStatus.OPEN, SessionStatus.CLOSED, SessionStatus.CANCELLED, SessionStatus.UNRESOLVED]) {
      expect(codeOf(() => policy.assertCanOpen(s(st), T('2026-11-13T09:05:00Z'), cfg))).toBe('INVALID_STATE_TRANSITION');
    }
  });

  it('only OPEN sessions can be closed', () => {
    expect(codeOf(() => policy.assertCanClose(s(SessionStatus.OPEN)))).toBeUndefined();
    expect(codeOf(() => policy.assertCanClose(s(SessionStatus.SCHEDULED)))).toBe('INVALID_STATE_TRANSITION');
  });

  it('SCHEDULED and UNRESOLVED sessions can be confirmed held, but only after they ended', () => {
    expect(codeOf(() => policy.assertCanConfirmHeld(s(SessionStatus.UNRESOLVED), T('2026-11-15T00:00:00Z')))).toBeUndefined();
    expect(codeOf(() => policy.assertCanConfirmHeld(s(SessionStatus.SCHEDULED), T('2026-11-13T12:30:00Z')))).toBeUndefined();
    expect(codeOf(() => policy.assertCanConfirmHeld(s(SessionStatus.SCHEDULED), T('2026-11-13T10:00:00Z')))).toBe('SESSION_NOT_ENDED');
    expect(codeOf(() => policy.assertCanConfirmHeld(s(SessionStatus.CANCELLED), T('2026-11-15T00:00:00Z')))).toBe('INVALID_STATE_TRANSITION');
  });

  it('cancelling: allowed from SCHEDULED/OPEN/UNRESOLVED/CLOSED; CLOSED needs a note; CANCELLED cannot be re-cancelled', () => {
    for (const st of [SessionStatus.SCHEDULED, SessionStatus.OPEN, SessionStatus.UNRESOLVED]) {
      expect(codeOf(() => policy.assertCanCancel(s(st), undefined))).toBeUndefined();
    }
    expect(codeOf(() => policy.assertCanCancel(s(SessionStatus.CLOSED), undefined))).toBe('NOTE_REQUIRED');
    expect(codeOf(() => policy.assertCanCancel(s(SessionStatus.CLOSED), 'recorded by mistake'))).toBeUndefined();
    expect(codeOf(() => policy.assertCanCancel(s(SessionStatus.CANCELLED), 'x'))).toBe('INVALID_STATE_TRANSITION');
  });

  it('a past SCHEDULED session becomes UNRESOLVED 24h after planned end — never CANCELLED', () => {
    expect(policy.shouldMarkUnresolved(s(SessionStatus.SCHEDULED), T('2026-11-14T11:59:00Z'), cfg)).toBe(false);
    expect(policy.shouldMarkUnresolved(s(SessionStatus.SCHEDULED), T('2026-11-14T12:01:00Z'), cfg)).toBe(true);
    expect(policy.shouldMarkUnresolved(s(SessionStatus.CLOSED), T('2026-11-20T00:00:00Z'), cfg)).toBe(false);
  });

  it('OPEN sessions auto-close at planned end + close grace, deterministically', () => {
    const open = s(SessionStatus.OPEN, { openedAt: T('2026-11-13T09:00:00Z') });
    expect(policy.shouldAutoClose(open, T('2026-11-13T12:29:00Z'), cfg)).toBe(false);
    expect(policy.shouldAutoClose(open, T('2026-11-13T12:31:00Z'), cfg)).toBe(true);
    expect(policy.autoCloseAt(open, cfg)).toEqual(T('2026-11-13T12:30:00Z'));
  });

  it('reinstated sessions return to SCHEDULED, or UNRESOLVED if their resolution deadline passed', () => {
    expect(policy.statusAfterReinstate(base, T('2026-11-13T13:00:00Z'), cfg)).toBe(SessionStatus.SCHEDULED);
    expect(policy.statusAfterReinstate(base, T('2026-11-20T13:00:00Z'), cfg)).toBe(SessionStatus.UNRESOLVED);
  });

  it('only SCHEDULED sessions are editable', () => {
    expect(codeOf(() => policy.assertEditable(s(SessionStatus.SCHEDULED)))).toBeUndefined();
    expect(codeOf(() => policy.assertEditable(s(SessionStatus.OPEN)))).toBe('SESSION_NOT_EDITABLE');
  });
});

describe('admission window', () => {
  it('defaults to [plannedStart − early grace, plannedEnd + close grace]', () => {
    expect(admissionWindow(base, cfg)).toEqual({ start: T('2026-11-13T08:00:00Z'), end: T('2026-11-13T12:30:00Z') });
  });

  it('ends at closedAt once attendance is closed (manually or automatically)', () => {
    expect(admissionWindow({ ...base, closedAt: T('2026-11-13T11:00:00Z') }, cfg).end).toEqual(T('2026-11-13T11:00:00Z'));
  });

  it('starts earlier if the session was opened before the early grace', () => {
    expect(admissionWindow({ ...base, openedAt: T('2026-11-13T07:30:00Z') }, cfg).start).toEqual(T('2026-11-13T07:30:00Z'));
  });
});
