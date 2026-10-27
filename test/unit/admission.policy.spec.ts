import { AdmissionFacts, evaluateAdmission, resolveSession, SessionCandidate } from '../../src/attendance/admission.policy';
import { RejectReason, SessionStatus } from '../../src/generated/prisma/client';
import { SessionTimingConfig } from '../../src/sessions/session-timing';

const cfg: SessionTimingConfig = { earlyGraceMinutes: 60, closeGraceMinutes: 30, unresolvedAfterHours: 24 };
const T = (iso: string) => new Date(iso);
const GROUP = 'g-1';

const session = (over: Partial<SessionCandidate> = {}): SessionCandidate => ({
  id: 's-1',
  groupId: GROUP,
  status: SessionStatus.OPEN,
  plannedStart: T('2026-11-13T09:00:00Z'),
  plannedEnd: T('2026-11-13T12:00:00Z'),
  openedAt: T('2026-11-13T09:00:00Z'),
  closedAt: null,
  ...over,
});

function facts(over: Partial<AdmissionFacts> = {}): AdmissionFacts {
  return {
    capturedAt: T('2026-11-13T10:37:00Z'),
    receivedAt: T('2026-11-13T10:38:00Z'),
    minCaptureDate: T('2024-01-01T00:00:00Z'),
    futureToleranceMs: 300_000,
    card: { id: 'c-1', status: 'ASSIGNED' },
    assignmentAtCapture: { id: 'a-1', memberId: 'm-1' },
    cardAssignmentEndedBeforeCapture: false,
    member: { id: 'm-1', status: 'ACTIVE', deactivatedAt: null },
    session: { kind: 'FOUND', session: session(), reassigned: false },
    memberships: [{ id: 'ms-1', groupId: GROUP, joinedAt: T('2026-08-01T00:00:00Z'), leftAt: null }],
    ...over,
  };
}

const reject = (f: AdmissionFacts) => {
  const d = evaluateAdmission(f, cfg);
  return d.decision === 'REJECT' ? d.reason : 'ACCEPT';
};

describe('AttendanceAdmissionPolicy.evaluateAdmission', () => {
  it('accepts a valid tap during an open session', () => {
    const d = evaluateAdmission(facts(), cfg);
    expect(d).toMatchObject({ decision: 'ACCEPT', sessionId: 's-1', memberId: 'm-1', membershipId: 'ms-1', cardAssignmentId: 'a-1', lateSync: false });
  });

  it('accepts an offline tap uploaded long after the session closed, judged on tap time (lateSync)', () => {
    const closed = session({ status: SessionStatus.CLOSED, closedAt: T('2026-11-13T12:00:00Z') });
    const d = evaluateAdmission(
      facts({ capturedAt: T('2026-11-13T11:37:00Z'), receivedAt: T('2026-11-13T14:00:00Z'), session: { kind: 'FOUND', session: closed, reassigned: false } }),
      cfg,
    );
    expect(d).toMatchObject({ decision: 'ACCEPT', lateSync: true });
  });

  it('rejects a tap captured after attendance was closed', () => {
    const closed = session({ status: SessionStatus.CLOSED, closedAt: T('2026-11-13T12:00:00Z') });
    expect(reject(facts({ capturedAt: T('2026-11-13T12:05:00Z'), receivedAt: T('2026-11-13T14:00:00Z'), session: { kind: 'FOUND', session: closed, reassigned: false } }))).toBe(RejectReason.SESSION_NOT_OPEN);
  });

  it('accepts taps in the early grace window and rejects before it', () => {
    expect(reject(facts({ capturedAt: T('2026-11-13T08:01:00Z') }))).toBe('ACCEPT');
    expect(reject(facts({ capturedAt: T('2026-11-13T07:59:00Z') }))).toBe(RejectReason.SESSION_NOT_OPEN);
  });

  it('accepts taps on a SCHEDULED or UNRESOLVED session inside the window (device is offline; confirmation is separate)', () => {
    for (const status of [SessionStatus.SCHEDULED, SessionStatus.UNRESOLVED]) {
      const s = session({ status, openedAt: null });
      expect(reject(facts({ session: { kind: 'FOUND', session: s, reassigned: false } }))).toBe('ACCEPT');
    }
  });

  it.each([
    ['epoch clock', T('1970-01-01T00:00:10Z')],
    ['far future', T('2026-11-13T11:00:00Z')],
  ])('rejects an implausible capture time (%s)', (_label, capturedAt) => {
    expect(reject(facts({ capturedAt }))).toBe(RejectReason.INVALID_TIMESTAMP);
  });

  it('allows small device clock drift into the future', () => {
    expect(reject(facts({ capturedAt: T('2026-11-13T10:40:00Z'), receivedAt: T('2026-11-13T10:38:00Z') }))).toBe('ACCEPT');
  });

  it('rejects an unknown card', () => {
    expect(reject(facts({ card: null, assignmentAtCapture: null }))).toBe(RejectReason.UNKNOWN_CARD);
  });

  it('rejects a registered card that was never assigned at that time', () => {
    expect(reject(facts({ card: { id: 'c-1', status: 'UNASSIGNED' }, assignmentAtCapture: null }))).toBe(RejectReason.CARD_NOT_ASSIGNED);
  });

  it('rejects a revoked card / a card whose assignment ended before the tap', () => {
    expect(reject(facts({ card: { id: 'c-1', status: 'REVOKED' }, assignmentAtCapture: null }))).toBe(RejectReason.CARD_REVOKED);
    expect(reject(facts({ card: { id: 'c-1', status: 'UNASSIGNED' }, assignmentAtCapture: null, cardAssignmentEndedBeforeCapture: true }))).toBe(
      RejectReason.CARD_REVOKED,
    );
  });

  it('accepts a tap made before the card was revoked (rules use capture time)', () => {
    // The assignment covering capturedAt exists even though the card is REVOKED now.
    expect(reject(facts({ card: { id: 'c-1', status: 'REVOKED' } }))).toBe('ACCEPT');
  });

  it('rejects a member deactivated before the tap, accepts if deactivated after', () => {
    expect(reject(facts({ member: { id: 'm-1', status: 'INACTIVE', deactivatedAt: T('2026-11-13T10:00:00Z') } }))).toBe(RejectReason.MEMBER_INACTIVE);
    expect(reject(facts({ member: { id: 'm-1', status: 'INACTIVE', deactivatedAt: T('2026-11-14T10:00:00Z') } }))).toBe('ACCEPT');
  });

  it('rejects when the session belongs to another group than the device', () => {
    expect(reject(facts({ session: { kind: 'OTHER_GROUP', sessionId: 's-x' } }))).toBe(RejectReason.DEVICE_NOT_AUTHORIZED);
  });

  it('rejects a cancelled session and when no session matches', () => {
    expect(reject(facts({ session: { kind: 'CANCELLED', sessionId: 's-1' } }))).toBe(RejectReason.SESSION_CANCELLED);
    expect(reject(facts({ session: { kind: 'NONE' } }))).toBe(RejectReason.NO_MATCHING_SESSION);
  });

  it('rejects a member who never belonged to the session group', () => {
    expect(reject(facts({ memberships: [{ id: 'ms-2', groupId: 'other', joinedAt: T('2026-01-01T00:00:00Z'), leftAt: null }] }))).toBe(
      RejectReason.MEMBER_NOT_IN_GROUP,
    );
  });

  it('rejects a member who joined the group after the session started', () => {
    expect(reject(facts({ memberships: [{ id: 'ms-1', groupId: GROUP, joinedAt: T('2026-11-13T09:30:00Z'), leftAt: null }] }))).toBe(
      RejectReason.NOT_ELIGIBLE_FOR_SESSION,
    );
  });

  it('rejects a member whose membership ended before the session', () => {
    expect(
      reject(facts({ memberships: [{ id: 'ms-1', groupId: GROUP, joinedAt: T('2026-01-01T00:00:00Z'), leftAt: T('2026-11-10T00:00:00Z') }] })),
    ).toBe(RejectReason.NOT_ELIGIBLE_FOR_SESSION);
  });

  it('carries resolved identifiers on rejections for auditability', () => {
    const d = evaluateAdmission(facts({ session: { kind: 'CANCELLED', sessionId: 's-9' } }), cfg);
    expect(d).toMatchObject({ decision: 'REJECT', sessionId: 's-9', memberId: 'm-1', cardId: 'c-1', cardAssignmentId: 'a-1' });
  });
});

describe('resolveSession', () => {
  const at = T('2026-11-13T10:00:00Z');

  it('uses a claimed, non-cancelled session of the device group', () => {
    const s = session();
    expect(resolveSession(s, [], GROUP, at, cfg)).toEqual({ kind: 'FOUND', session: s, reassigned: false });
  });

  it('refuses a claimed session from another group', () => {
    expect(resolveSession(session({ groupId: 'other' }), [], GROUP, at, cfg)).toEqual({ kind: 'OTHER_GROUP', sessionId: 's-1' });
  });

  it('falls back to time-based resolution when the claimed session was cancelled (e.g. rescheduled)', () => {
    const cancelled = session({ id: 'old', status: SessionStatus.CANCELLED });
    const replacement = session({ id: 'new', status: SessionStatus.SCHEDULED, openedAt: null });
    expect(resolveSession(cancelled, [cancelled, replacement], GROUP, at, cfg)).toEqual({ kind: 'FOUND', session: replacement, reassigned: true });
    expect(resolveSession(cancelled, [cancelled], GROUP, at, cfg)).toEqual({ kind: 'CANCELLED', sessionId: 'old' });
  });

  it('resolves by time when no session is claimed, preferring the nearest planned start', () => {
    const a = session({ id: 'a', plannedStart: T('2026-11-13T07:00:00Z'), plannedEnd: T('2026-11-13T09:45:00Z'), openedAt: null, status: SessionStatus.SCHEDULED });
    const b = session({ id: 'b', plannedStart: T('2026-11-13T10:15:00Z'), plannedEnd: T('2026-11-13T12:00:00Z'), openedAt: null, status: SessionStatus.SCHEDULED });
    expect(resolveSession(null, [a, b], GROUP, at, cfg)).toMatchObject({ kind: 'FOUND', session: { id: 'b' } });
  });

  it('reports a cancelled session when the tap falls only inside a cancelled one', () => {
    const c = session({ status: SessionStatus.CANCELLED });
    expect(resolveSession(null, [c], GROUP, at, cfg)).toEqual({ kind: 'CANCELLED', sessionId: 's-1' });
    expect(resolveSession(null, [], GROUP, at, cfg)).toEqual({ kind: 'NONE' });
  });
});
