# Testing

163 automated tests in three layers. Integration and e2e tests run against a **real PostgreSQL**
(the disposable `postgres-test` container), because most guarantees, such as uniqueness, overlap
prevention and append-only triggers, live in the database.

## Running

```bash
docker compose up -d postgres-test     # in-memory PostgreSQL on :5433 (once)

npm test                    # unit only — no database needed (~6 s)
npm run test:integration    # services + PostgreSQL
npm run test:e2e            # full HTTP stack (real AppModule, guards, pipes, filters)
npm run test:all            # everything (~45 s)
npm run test:cov            # with coverage report in coverage/
```

- The test runner applies all migrations to the test database first (`test/global-setup.ts`). Each test file truncates the tables it needs.
- Point at another database with `TEST_DATABASE_URL`. Redis is not needed (rate limiting falls back to memory).
- Jobs are disabled in tests and invoked explicitly where tested.

## What is covered

### Unit (`test/unit`, pure functions, no I/O)
| File | Covers |
|---|---|
| `admission.policy.spec.ts` | every reject reason, rule ordering, capture-time evaluation (tap before revocation accepted; offline tap uploaded after close accepted with `lateSync`; tap after close rejected), clock drift tolerance, session resolution (claimed vs time-based, cancelled → re-resolve, other group) |
| `eligibility.spec.ts` | joined 08:00 vs meeting 10:00 (eligible), joined 14:00 (not), boundaries `joinedAt == start` and `leftAt == start`, transfers, re-joining after a gap |
| `session-lifecycle.spec.ts` | allowed/denied transitions, open-time range, confirm-held only after end, CLOSED → CANCELLED needs a note, UNRESOLVED after 24 h (never cancelled), deterministic auto-close, reinstate target status, admission windows |
| `occurrence-calculator.spec.ts` | weekly generation, effective-period clipping, Lagos → UTC conversion, DST zones |
| `authorization.spec.ts` | role → permission matrix (LGI_VIEWER has no write permission, CDS_ADMIN cannot manage users), AccessScope 404 behaviour |
| `utilities.spec.ts` | card UID normalisation, CSV escaping + formula injection, audit redaction, constant-time compare, DB error classification |

### Integration (`test/integration`, services + PostgreSQL)
| File | Covers |
|---|---|
| `constraints.int-spec.ts` | all hand-written constraints exist after a clean migration; overlapping memberships refused; back-to-back allowed; one holder per card and one card per member; no overlapping sessions; one record per member per session; records/events cannot be deleted; acks immutable; audit log append-only; device identifier unique |
| `ingestion.int-spec.ts` | same event twice → one record + identical ack; 8 concurrent retries → one record; same member from two devices concurrently → one record (`ACCEPTED` + `ALREADY_RECORDED`); duplicate taps; id reuse with different payload → `DUPLICATE_EVENT`; rejected events retained; card replacement (old card valid before, `CARD_REVOKED` after, history kept); cancelled session |
| `reports.int-spec.ts` | the 10-session scenario: member joining after session 4 who attends 5 of 6 → **83.33 %**; leaver not counted absent afterwards; eligible set changes per session; absent = eligible − present; cancelled excluded; unresolved excluded with warning; pooled group rate; date ranges |
| `schedules-jobs.int-spec.ts` | schedule → ~6 weeks of SCHEDULED sessions; idempotent regeneration; back-filled past occurrences are UNRESOLVED; UNRESOLVED after 24 h but not before; auto-close at end + grace; resolving UNRESOLVED as held or cancelled; ending a schedule cancels only untouched future sessions and preserves history; overlapping schedules refused |

### End-to-end (`test/e2e`, HTTP through the real application)
| File | Covers |
|---|---|
| `auth-rbac.e2e-spec.ts` | valid login, invalid credentials (generic, audited, no password in audit), disabled user (login refused, existing token dead), missing/malformed token, validation error shape, refresh rotation + reuse detection, logout, SUPER_ADMIN-only routes, LGI_VIEWER read-only, CDS_ADMIN cross-group 404s, scope removal immediate |
| `device-security.e2e-spec.ts` | active device auth + sync; unknown device and invalid secret (identical 401, audited); identifier alone rejected; PENDING, SUSPENDED (incl. pre-issued token; re-activation), REVOKED (permanent, history kept), DECOMMISSIONED rejected; rotation invalidates old secret and tokens; secrets never in responses; user/device tokens not interchangeable; device cannot use another group's sessions or roster; CDS admin limited to own devices |
| `memberships-cards.e2e-spec.ts` | join, leave, transfer (linked, audited), overlap refused, re-join, correction blocked when it would strand attendance, deactivation ends membership + card; card register/assign, one holder / one card, replacement history, revoke + reinstate + reuse, malformed UIDs, auditing |
| `sessions.e2e-spec.ts` | schedule generation + preview, open/close, future session can't be opened/confirmed and early taps rejected, cancellation reasons (system reason refused), cancelled session refuses device and manual attendance, cancel-with-attendance requires void, reinstate restores records, reinstate + reprocess recovers rejected taps while the device ack stays unchanged, UNRESOLVED via job then resolved both ways, rescheduling + overlap, lifecycle audit |
| `full-flow.e2e-spec.ts` | the required 10 steps (group → member → card → session → device → upload → retry → exactly one record → view → report + CSV), then: ETag/304, mixed batch with per-event results in order, whole-batch replay idempotent, duplicates inside one batch, late offline upload accepted on tap time, tap after close rejected, membership rejections + correction + reprocess, oversized/malformed batches refused and logged as failed syncs, heartbeat, sync/security auditing |

## Manual testing tips

- Swagger UI at `/api/docs`: log in, click **Authorize**, paste the access token.
- `SEED_DEMO_DATA=true npm run db:seed` creates a group with a Friday schedule, 5 members with cards and an ACTIVE device. The device secret is printed once.
- To see time-based behaviour without waiting, create **ad-hoc sessions** with past or future times (`POST /sessions`) and use `confirm-held` / `open`. Restart the API (or wait 15 min) to run the maintenance job that marks UNRESOLVED and auto-closes.
- Inspect what happened through `/audit-logs`, `/devices/:id/sync-events` and `/attendance/events`.
