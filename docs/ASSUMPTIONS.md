# Assumptions & decisions

Decisions made where the requirements were silent or ambiguous. Each one is reflected in code and tests.

## Confirmed by the product owner

| Topic | Decision |
|---|---|
| Meeting confirmation | Only an authorized administrator can confirm that a meeting happened (open live, or confirm-held afterwards). Device taps never confirm a meeting, whatever their number. |
| Meeting not held | `CANCELLED` + reason (`PUBLIC_HOLIDAY`, `OFFICIAL_NYSC_ACTIVITY`, `VENUE_UNAVAILABLE`, `SECURITY`, `WEATHER`, `NOT_HELD`, `OTHER`). There is no separate `MISSED` status. |
| Unknown outcome | `UNRESOLVED` (system-set 24 h after the planned end). **Never** automatically turned into `CANCELLED`. An admin resolves it as held or cancelled. |
| Membership validity | timestamps; eligible iff `joinedAt <= session.plannedStart AND (leftAt IS NULL OR leftAt > session.plannedStart)` |
| Card inventory | central shared stock; assignment history preserved; replacement never overwrites |
| Session generation | ~6 weeks ahead (`SESSION_GENERATION_HORIZON_WEEKS`) |
| BullMQ | not used. No implemented requirement needs a queue. |

## Engineering decisions

| # | Decision | Why / alternative |
|---|---|---|
| 1 | **"Session start" for eligibility = `plannedStart`** (not `openedAt`) | Deterministic, and known in advance. The alternative (actual start) would make eligibility change when an admin opens late. |
| 2 | **Device taps on `SCHEDULED` / `UNRESOLVED` sessions are accepted** (inside the window) but don't count in statistics until the meeting is confirmed held | Offline devices can't know whether an admin opened the session. Rejecting would lose real attendance. |
| 3 | **Admission window** = `[plannedStart − 60 min (or openedAt if earlier), closedAt ?? plannedEnd + 30 min]` | Configurable. Auto-close fixes `closedAt = plannedEnd + 30 min`. A manual close earlier stops accepting taps captured after that moment. |
| 4 | **Business rules use capture time** (`capturedAt`) | A card revoked or member deactivated *after* the tap doesn't invalidate it. Upload delay never changes the outcome. |
| 5 | **First tap wins** for a member/session; later taps → `ALREADY_RECORDED` | The record keeps the first accepted `capturedAt`. Taps are processed in capture order within a batch. |
| 6 | **Presence only** (no "late" status, no check-out) | Lateness can be derived later from `capturedAt − plannedStart`. |
| 7 | **`REJECTED` is final for the device**; admins can *reprocess* after fixing data | The device's acknowledgement is immutable (DB trigger), so retries are consistent. Recovery happens server-side. |
| 8 | **Unknown-card taps are uploaded and stored**, not dropped on the device | Lets an admin recover attendance after registering the card. |
| 9 | **Manual attendance requires eligibility.** There is no override. | Keeps *present ⊆ eligible* (rates ≤ 100 %). Fix the membership (audited) instead. |
| 10 | **Membership changes that would strand attendance are refused** (409) | Admins must void those records explicitly first. History never silently becomes inconsistent. |
| 11 | **A member belongs to at most one group at a time** (DB-enforced) | Concurrent memberships would make "absent" ambiguous. |
| 12 | **Membership `status` is derived** (`ACTIVE` / `UPCOMING` / `ENDED`) from timestamps, not stored | Avoids stale state for future-dated changes. |
| 13 | **Member deactivation** ends the current membership and the active card assignment (card returns to stock). Reactivation restores neither. | Explicit re-assignment is safer than implicit restoration. |
| 14 | **Transfers keep the member's card** | The card belongs to the person, not the group. |
| 15 | **Schedules are versioned**: timing fields are immutable; end + create to change day/time | Old sessions always point at the rule that produced them. |
| 16 | **Ending a schedule cancels only untouched future occurrences** (reason `SCHEDULE_CHANGED`, an admin-initiated action); sessions with data are kept and reported | Never modifies history or discards data. |
| 17 | **Sessions of one group can't overlap**; **no two active schedules on the same weekday** with overlapping effective periods | Keeps time-based session resolution unambiguous. |
| 18 | **Meetings don't cross midnight** (`endLocalTime > startLocalTime`) | Matches CDS practice and simplifies dates. |
| 19 | **Timezone per schedule** (default `Africa/Lagos`). Each session stores its own timezone and local `occurrenceDate`. | Report date ranges filter on `occurrenceDate`. |
| 20 | **Back-filling past occurrences** is opt-in (`backfillPast`). Back-filled sessions start `UNRESOLVED`. | Never claims past meetings happened. |
| 21 | **Cancelling a session with attendance** requires `voidExistingAttendance: true`; reinstating restores exactly the records voided by the cancellation | A cancelled session never carries active attendance. |
| 22 | **Device lifecycle**: `PENDING` (registered, can't sync) → `ACTIVE` ⇄ `SUSPENDED`; `REVOKED` (terminal, except decommission); `DECOMMISSIONED` (terminal) | Revoke and decommission bump the credential version. |
| 23 | **Device auth = secret → 1 h JWT** (not a secret on every request) | Limits secret exposure; revocation is still immediate because every request re-checks the device. |
| 24 | **Roster sync = full snapshot + ETag**, not a change feed | The roster is small. Change feeds lose rows under out-of-order commits. Revisit above ~5,000 rows per device. |
| 25 | **Roster includes `displayName` + `stateCode`** | For on-device feedback. Drop them if the device has no display. |
| 26 | **CDS_ADMIN may register, activate, suspend, revoke, decommission and rotate devices of their own groups** | Interpreted from "Synchronize devices". |
| 27 | **Blank cards are visible to every CDS_ADMIN** (shared stock); assignment history shows only holders in the viewer's scope | Matches central inventory without leaking other groups' members. |
| 28 | **Out-of-scope resources return 404**, not 403 | Prevents enumeration. |
| 29 | **`stateCode` is globally unique** and normalised to upper case without spaces | NYSC state codes are unique nationally. |
| 30 | **Card UIDs** are stored normalised (upper-case hex, 4–16 bytes). The UID is the only card identifier. | Not a secret. See SECURITY.md for anti-cloning. |
| 31 | **Group % = pooled** (Σ present / Σ eligible); the mean of per-session % is also returned | The pooled figure is the honest aggregate; the mean is often what people expect to see. |
| 32 | **OPEN sessions** show live statistics but are excluded from range totals until closed | Avoids reporting provisional absences as final. |
| 33 | **NestJS 11** (not 12), **Jest 29** (not 30) | NestJS 12 is ESM-only. Jest 30's native resolver failed to load on the dev machine. Both are mainstream, supported versions. |

## Known limitations

- **Device firmware is out of scope.** The protocol is documented in [DEVICE_SYNC.md](DEVICE_SYNC.md).
- **No PDF export yet.** The `ReportFormatter` interface is in place.
- **Incremental roster sync** is snapshot + ETag. There are no per-row deltas.
- **Rejected-event recovery is manual** (reprocess/dismiss). There are no automatic notifications.
- **Plain UIDs**: cloned cards can't be detected.
- **Device credential provisioning is manual** (copy the secret onto the device). There is no device-initiated rotation.
- **Jobs run in-process** every 15 minutes. If every instance is down, transitions catch up on the next start.
- **Device clock skew is recorded but not corrected.** Timestamps are trusted within the plausibility bounds.
- **No soft "undo"** for membership deletion, because memberships are never deleted, only ended or corrected.
- See [SECURITY.md](SECURITY.md#not-yet-hardened) for security gaps.

## Future improvements

PDF reports · notifications for UNRESOLVED sessions and failed syncs · NTAG 424 DNA anti-cloning ·
device-initiated credential rotation with an overlap window · change-feed sync for large rosters ·
admin MFA · httpOnly refresh cookie · metrics (Prometheus/OpenTelemetry) · data-retention automation.
