# Architecture

> Revision 3 — **as implemented**. Revisions 1–2 were the pre-implementation designs; the decisions
> that changed during review are listed in the history below and in [ASSUMPTIONS.md](ASSUMPTIONS.md).

| Rev | Change |
|---|---|
| 1 | Initial design: modular monolith, event inbox + canonical records, DB-enforced idempotency, snapshot sync |
| 2 | Recurring schedules, expected-session lifecycle, time-bounded memberships, historical card assignments |
| 3 | Final product decisions: timestamp-based memberships, `UNRESOLVED` never auto-cancelled, admin-only meeting confirmation, device states `PENDING/ACTIVE/SUSPENDED/REVOKED/DECOMMISSIONED`, card lifecycle `UNASSIGNED → ASSIGNED → REVOKED/UNASSIGNED` |

---

## 1. Principles

```
LOCAL TAP → STORE ON DEVICE → QUEUE → BATCH → SYNC → PER-EVENT ACK → MARK SYNCED
```

1. **The device never needs to be online to capture attendance.** The backend judges every tap by the time it was **captured**, not the time it was uploaded.
2. **Synchronization is idempotent at the database level.** `UNIQUE(deviceId, clientEventId)` and `UNIQUE(sessionId, memberId)`.
3. **Nothing disappears.** Every uploaded tap is stored as an `AttendanceEvent` with an explicit outcome. Records are voided, never deleted, and the database blocks deletes.
4. **A schedule produces expectations, not facts.** A meeting counts only once an authorized person confirms it happened.
5. **Membership and card ownership are time-bounded history**, never overwritten.
6. **Business rules live in pure policy functions**, not in controllers. Integrity rules also live in the database.

## 2. System overview

```
 NFC device (offline-first)                       Web dashboard
   local roster + event queue                      SUPER_ADMIN / CDS_ADMIN / LGI_VIEWER
        │  HTTPS, device token                            │ HTTPS, user JWT
        ▼                                                 ▼
 ┌──────────────────────────── NestJS modular monolith (/api/v1) ────────────────────────────┐
 │ synchronization ── attendance (policy + ingestion) ── sessions ── schedules ── jobs        │
 │ devices · members/memberships · cards/assignments · groups · users · auth · reports · audit│
 └──────────────────────────────────────┬──────────────────────────────┬─────────────────────┘
                                        ▼                              ▼
                               PostgreSQL (source of truth)     Redis (rate-limit counters only)
```

One deployable and one database. There are no message brokers. Periodic maintenance runs in-process
(`@nestjs/schedule`) under a PostgreSQL advisory lock, so several instances can run safely.

### Layering

```
controller (HTTP, DTO validation, guards)
   → application service (transactions, scope checks, audit — same transaction)
      → domain policy (pure functions: admission, lifecycle, eligibility, occurrences)
      → Prisma (PostgreSQL; constraints are the last line of defence)
```

| Pure policy | File |
|---|---|
| Attendance admission + session resolution | `src/attendance/admission.policy.ts` |
| Session lifecycle transitions | `src/sessions/session-lifecycle.policy.ts` |
| Admission window | `src/sessions/session-timing.ts` |
| Membership eligibility | `src/members/eligibility.ts` |
| Schedule → occurrences (timezone-aware) | `src/schedules/occurrence-calculator.ts` |

### Modules

| Module | Responsibility |
|---|---|
| `auth` | login, refresh-token rotation, JWT guard, permission guard, `AccessScope` |
| `users` | dashboard users, roles, group scopes (SUPER_ADMIN only) |
| `groups` | CDS groups |
| `schedules` | recurring weekly schedules, generation of expected sessions |
| `sessions` | lifecycle: open / close / confirm-held / cancel / reinstate / reschedule; system transitions |
| `members` | members, time-bounded group memberships (join, leave, transfer, correct), eligibility |
| `cards` | card inventory, time-bounded assignments, replacement, revocation |
| `attendance` | admission policy, idempotent ingestion, records, manual corrections, event inbox, reprocessing |
| `devices` | registry, lifecycle, credential issue/rotation, sync history |
| `synchronization` | device token, device guard, snapshot (ETag), batch upload, heartbeat |
| `reports` | eligibility-based statistics, CSV export via a formatter interface |
| `audit` | append-only audit log + query API |
| `jobs` | periodic maintenance (calls services; no logic of its own) |

## 3. Domain model

```
CDS Group
  ├─▶ CDS Schedule (weekday, local start/end, timezone, effectiveFrom/Until, ACTIVE|INACTIVE)
  │      └─▶ Expected Session (generated)  ─┐
  ├─▶ Ad-hoc Session  ──────────────────────┤
  │                                         ▼
  │                Session status: SCHEDULED · OPEN · CLOSED · UNRESOLVED · CANCELLED(reason)
  │                                         ▼
  │                Attendance Record (official) ◀── Attendance Event (raw tap + ack) ◀── Device
  └─▶ Device (PENDING · ACTIVE · SUSPENDED · REVOKED · DECOMMISSIONED)

Member (identity: fullName, stateCode, status)
  ├─▶ Group Membership   [joinedAt, leftAt)      timestamps, never overlapping per member
  └─▶ Card Assignment    [assignedAt, endedAt)   timestamps, no overlap per card / per member ──▶ Card (UNASSIGNED · ASSIGNED · REVOKED)
```

**Session status and member eligibility are separate concepts.** For any (member, session) pair, the
reports derive a *participation* value from both:

| Participation | Meaning |
|---|---|
| `PRESENT` | eligible, record present, session held |
| `ABSENT` | eligible, no record, session held (`OPEN`/`CLOSED`) |
| `NOT_RECORDED` | session not (yet) confirmed held |
| `PENDING_RESOLUTION` | session `UNRESOLVED` |
| `CANCELLED` | session cancelled; no attendance expected |
| `UPCOMING` | future session |
| (not listed) | not yet a member, membership ended, or not in the group: not eligible, so neither present nor absent |

## 4. Session lifecycle

```
                 open (around planned time)             close / auto-close
   SCHEDULED ─────────────────────────────▶ OPEN ───────────────────────────▶ CLOSED
     │  │                                     │                                 ▲  │
     │  └── confirm-held (after planned end) ─┼─────────────────────────────────┘  │ cancel (note required)
     │                                        │ cancel                             ▼
     ├── cancel (reason) ─────────────────────┴──────────────────────────────▶ CANCELLED
     │                                                                            │
     └── SYSTEM: plannedEnd + 24 h, no decision ──▶ UNRESOLVED ── confirm-held ──▶ CLOSED
                                                        └────── cancel ─────────▶ CANCELLED
   CANCELLED ── reinstate ──▶ SCHEDULED (or UNRESOLVED if its deadline passed)
```

| Status | Meeting happened? | Counts in statistics | Device taps accepted (inside window) |
|---|---|---|---|
| `SCHEDULED` | unknown (expected) | no | yes: the device is offline, and confirmation is separate |
| `OPEN` | yes (confirmed live) | live view only | yes |
| `CLOSED` | yes (confirmed) | **yes** | yes, if captured before `closedAt` (flagged `lateSync` when uploaded after) |
| `UNRESOLVED` | unknown, **admin must resolve** | no (warning in reports) | yes (late uploads are still expected) |
| `CANCELLED` | no (confirmed by an authorized person) | no, no attendance expected | no, stored as `REJECTED/SESSION_CANCELLED` |

- **Only an authorized person makes a meeting "held"**: by opening it live or by `confirm-held`. Device taps never confirm a meeting, however many there are.
- **The system never turns `UNRESOLVED` into `CANCELLED`.** That would be a false historical statement.
- **Cancellation reasons:** `PUBLIC_HOLIDAY`, `OFFICIAL_NYSC_ACTIVITY`, `VENUE_UNAVAILABLE`, `SECURITY`, `WEATHER`, `NOT_HELD`, `OTHER`, plus an optional note. `SCHEDULE_CHANGED` is set only when an admin ends a schedule.
- **Cancelling a session that has `PRESENT` records** requires `voidExistingAttendance: true`. The records are voided (reason `SESSION_CANCELLED`) in the same transaction. Reinstating restores exactly those records.
- **Admission window** (always judged on `capturedAt`):
  `start = min(plannedStart − 60 min, openedAt)`; `end = closedAt` if closed, else `plannedEnd + 30 min`.
  Auto-close sets `closedAt = plannedEnd + 30 min`, so normal meetings stop accepting new taps at that point.

### Schedules and generation

- A schedule is a weekly rule in an IANA timezone. Occurrences are generated **6 weeks ahead** (configurable) when the schedule is created, and by the maintenance job every 15 minutes.
- Generation is idempotent: `UNIQUE(scheduleId, occurrenceDate)` plus the no-overlap exclusion constraint, inserted with `ON CONFLICT DO NOTHING`.
- **Schedules are versioned, not edited.** To change the day or time, *end* the schedule and create a new one. Ending one cancels only future generated sessions that are still `SCHEDULED` and have no records or events. Past sessions and sessions with data are never modified.
- Each session copies its own `timezone` and `occurrenceDate`, so history never shifts when a schedule changes.
- A single occurrence can be rescheduled (`PATCH`) while it is `SCHEDULED` and has no attendance.

## 5. Membership and eligibility

```
eligible(member, session)  ⇔  ∃ membership m in session.group :
        m.joinedAt <= session.plannedStart  AND  (m.leftAt IS NULL OR m.leftAt > session.plannedStart)
```

- Joined at 08:00, meeting at 10:00 → eligible. Joined at 14:00 → not eligible.
- **Transfer** ends the old membership and starts the new one at the same instant, linked, in one transaction. **Leave** sets `leftAt` with a reason. **Re-join** adds a new row. **Corrections** are audited before/after.
- The database prevents overlapping memberships, so a member is in at most one group at any instant.
- A membership change that would leave existing `PRESENT` records outside the period is refused (`409 MEMBERSHIP_HAS_ATTENDANCE`). As a result, *present ⊆ eligible* always holds, and percentages never exceed 100 %.
- The same rule is implemented in SQL (reports) and in TypeScript (admission). Tests check that both agree.

**Attendance %** = present ÷ held sessions the member was eligible for. A member who joins after session 4 of 10 and attends 5 of sessions 5–10 scores **83.33 %**, not 50 %.

## 6. Cards

- A `Card` is the physical tag in shared central inventory: `UNASSIGNED → ASSIGNED → UNASSIGNED` (returned) or `REVOKED` (lost/damaged/stolen/retired). A revoked card can be *reinstated* to `UNASSIGNED` and assigned again.
- A `CardAssignment` is the period `[assignedAt, endedAt)` during which a member held the card. Exclusion constraints guarantee one holder per card and one card per member at any instant.
- **Replacement** ends the old assignment (`REPLACED`) and starts the new one at the same instant, linked by `replacedByAssignmentId`. Taps with the old card before the replacement stay valid; taps after it are rejected as `CARD_REVOKED`.
- Only the UID is used on the card. No personal data is stored on it.

## 7. Attendance processing

Every uploaded tap gets one outcome:

| Ack | Meaning | Device action |
|---|---|---|
| `ACCEPTED` | new official record created | mark synced |
| `ALREADY_RECORDED` | member already recorded for that session (second tap / second device) | mark synced |
| `REJECTED` + reason | business rule failed; **the event is stored** and visible to admins | mark synced |
| `RETRY` | transient server error; nothing stored for this tap | resend later |

Rules, evaluated in order against `capturedAt` (`AttendanceAdmissionPolicy`):

| # | Rule | Reject reason |
|---|---|---|
| 1 | Capture time plausible (≥ `CAPTURE_MIN_DATE`, ≤ receivedAt + 5 min) | `INVALID_TIMESTAMP` |
| 2 | Card registered | `UNKNOWN_CARD` |
| 3 | An assignment covers `capturedAt` | `CARD_REVOKED` (assignment ended / card revoked) or `CARD_NOT_ASSIGNED` |
| 4 | Member not deactivated at that time | `MEMBER_INACTIVE` |
| 5 | Session resolved for the device's group | `DEVICE_NOT_AUTHORIZED` (claimed session of another group), `SESSION_CANCELLED`, `NO_MATCHING_SESSION` |
| 6 | `capturedAt` inside the session's admission window | `SESSION_NOT_OPEN` |
| 7 | Member eligible for the session | `MEMBER_NOT_IN_GROUP` (never a member of it), `NOT_ELIGIBLE_FOR_SESSION` (not yet joined / already left) |
| 8 | One record per member per session (DB) | → `ALREADY_RECORDED` |
| 9 | Same `clientEventId` with a different payload | `DUPLICATE_EVENT` (original kept) |

**Session resolution:** a claimed `sessionId` of the device's group that isn't cancelled is used as-is.
Otherwise, including when the claimed session was cancelled or rescheduled, the server picks the
non-cancelled session of the device's group whose window contains `capturedAt`, nearest planned start first.

Each tap is processed in **its own transaction**, so one bad tap never fails a batch. Concurrent
duplicates lose the race on a unique constraint and are retried, which resolves them as a replay or
`ALREADY_RECORDED`.

**Reprocessing:** after an admin fixes data (a membership date, a back-dated card assignment, a reinstated
session), `POST /attendance/events/reprocess` re-evaluates unresolved rejected events and creates
`REPROCESSED` records where they are now valid. The device's original acknowledgement is never changed
(a database trigger enforces this), so retries stay consistent.

**Manual corrections** (`attendance:correct`, note required): add a record for an eligible member to a
non-cancelled session; void or restore records. There is no override for ineligible members. Fix the
membership instead.

## 8. Devices and synchronization

Summary (full protocol in [DEVICE_SYNC.md](DEVICE_SYNC.md)):

| Call | Purpose |
|---|---|
| `POST /sync/token` | `deviceIdentifier + secret` → 1 h device token (ACTIVE devices only) |
| `GET /sync/snapshot` | group, config, card → member roster with membership validity, sessions with precomputed windows. `ETag` / `304` |
| `POST /sync/attendance-batches` | ≤ 200 taps, per-event acks in submission order, current `snapshotVersion` |
| `POST /sync/heartbeat` | firmware, battery, pending queue, device clock → skew |

On every request the device guard checks:
1. the token's signature and type
2. the device exists
3. it is `ACTIVE` (so not pending, suspended, revoked or decommissioned)
4. the token's credential version is current (rotation, revocation and decommission bump it)
5. the device's group is active

Uploads can only resolve sessions of the device's own group.

## 9. Reporting

- Statistics count only **held (`CLOSED`) sessions** and only members **eligible** at each session's start.
- `CANCELLED` sessions never count. `UNRESOLVED` sessions are excluded and reported as a warning (with the number of records attached), so an unconfirmed meeting can never silently make people look absent.
- Endpoints: per session, per group (per-session rows + pooled and mean rates), per group-member, per member (across memberships). All take `from`/`to` date ranges and `format=csv`.
- Rendering is behind a `ReportFormatter` interface. CSV ships (RFC 4180, UTF-8 BOM, formula-injection guard), and PDF can be added without touching any query.

## 10. Cross-cutting

| Concern | Implementation |
|---|---|
| Errors | one shape: `{ error: { code, message, details?, requestId } }`; DB constraint violations mapped to 409 |
| Responses | `{ data }` or `{ data, meta: { page, pageSize, total, totalPages } }` |
| Validation | `class-validator`, whitelist + forbid unknown fields |
| Logging | pino JSON. Request id (`X-Request-Id`), `userId`/`deviceId`, duration, sync summaries. Secrets redacted, UIDs masked |
| Audit | `AuditLog` rows written in the same transaction as the change. Append-only (trigger). Scoped by `groupId` |
| Rate limiting | `@nestjs/throttler`, Redis-backed when `REDIS_URL` is set |
| Jobs | in-process cron + `pg_try_advisory_xact_lock`. No BullMQ (no workload needs a queue) |
| Config | every env var validated at boot |

## 11. Why these technology choices

| Choice | Reason |
|---|---|
| NestJS 11 (not 12) | NestJS 12 is ESM-only, which breaks the Jest/ts-jest toolchain. 11 is current LTS-grade and CommonJS |
| Prisma 7 + `@prisma/adapter-pg` | required ORM; driver-adapter mode. Exclusion/CHECK constraints and triggers are hand-written SQL (Prisma ignores them when diffing, verified) |
| Luxon | correct local-time → UTC conversion for schedules in any IANA zone |
| Redis | shared rate-limit counters only; optional |
| No BullMQ | the periodic work is small, idempotent and lock-protected; sync must answer synchronously |
| No Passport | two small guards are clearer than strategy plumbing |
| Jest 29 | Jest 30's native resolver failed to load on the dev machine (missing VC++ runtime); 29 is fully supported by ts-jest |
