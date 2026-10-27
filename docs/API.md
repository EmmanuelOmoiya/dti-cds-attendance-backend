# API reference

- Base URL: `http://localhost:3000/api/v1` (URI-versioned)
- **Interactive OpenAPI docs: `/api/docs`** (JSON: `/api/docs-json`), generated from the code
- Dashboard routes need `Authorization: Bearer <user access token>`. `/sync/*` routes need a **device** token.

## Conventions

| Topic | Convention |
|---|---|
| Success, single | `200/201 { "data": { … } }` |
| Success, list | `200 { "data": [ … ], "meta": { "page", "pageSize", "total", "totalPages" } }` |
| Pagination | `?page=1&pageSize=20` (max 100) |
| Sorting | `?sort=field:asc,other:desc`. Only whitelisted fields; anything else → 400 |
| Filtering | resource-specific query params (below). Dates `YYYY-MM-DD`; instants ISO-8601 with offset |
| State changes | explicit action routes (`POST /sessions/:id/close`), not generic status PATCHes |
| No content | `204` for logout, change/reset password |
| Request id | send `X-Request-Id` or one is generated; echoed in the response header and in every error |

### Errors

```json
{ "error": { "code": "MEMBERSHIP_OVERLAP", "message": "The member already belongs to a CDS group during that period", "details": {…}, "requestId": "…" } }
```

| HTTP | Typical codes |
|---|---|
| 400 | `VALIDATION_FAILED` (`details: [{ field, issues[] }]`) |
| 401 | `UNAUTHENTICATED`, `INVALID_CREDENTIALS`, `INVALID_REFRESH_TOKEN`, `DEVICE_AUTH_FAILED` |
| 403 | `FORBIDDEN` (role lacks permission), `DEVICE_NOT_ACTIVE`, `DEVICE_GROUP_INACTIVE` |
| 404 | `NOT_FOUND`, including resources **outside your group scope** |
| 409 | `INVALID_STATE_TRANSITION`, `CONFLICT`, `EMAIL_TAKEN`, `GROUP_NAME_TAKEN`, `STATE_CODE_TAKEN`, `CARD_UID_TAKEN`, `CARD_ALREADY_ASSIGNED`, `MEMBER_HAS_ACTIVE_CARD`, `MEMBERSHIP_OVERLAP`, `MEMBERSHIP_HAS_ATTENDANCE`, `SESSION_OVERLAP`, `SESSION_HAS_ATTENDANCE`, `SESSION_NOT_EDITABLE`, `SCHEDULE_OVERLAP`, `ATTENDANCE_ALREADY_RECORDED`, `DEVICE_IDENTIFIER_TAKEN`, `GROUP_HAS_OPEN_SESSIONS`, `EVENT_NOT_REJECTED` |
| 413 | `BATCH_TOO_LARGE`, `PAYLOAD_TOO_LARGE` |
| 422 | business rule: `SESSION_OPEN_OUT_OF_RANGE`, `SESSION_NOT_ENDED`, `SESSION_CANCELLED`, `NOTE_REQUIRED`, `MEMBER_NOT_ELIGIBLE`, `MEMBER_INACTIVE`, `NO_ACTIVE_MEMBERSHIP`, `CARD_NOT_ASSIGNABLE`, `MEMBER_HAS_NO_ACTIVE_CARD`, `GROUP_INACTIVE`, `INVALID_TIME_RANGE`, `CANNOT_MODIFY_SELF` |
| 429 | `RATE_LIMITED` |
| 500 | `INTERNAL_ERROR` (details logged server-side only) |

## Endpoints

Permissions are listed per route. Scoped users (CDS_ADMIN, LGI_VIEWER) only reach their own groups' data.

### Auth
| Method | Path | Notes |
|---|---|---|
| POST | `/auth/login` | `{ email, password }` → `{ accessToken, refreshToken, accessTokenExpiresIn, refreshTokenExpiresAt }` (public, rate limited) |
| POST | `/auth/refresh` | `{ refreshToken }` → new pair (single-use, rotated) |
| POST | `/auth/logout` | `{ refreshToken }` → 204 |
| GET | `/auth/me` | current user + groups |
| POST | `/auth/change-password` | `{ currentPassword, newPassword }` → 204, signs out other sessions |

### Users — `users:manage` (SUPER_ADMIN)
| Method | Path | Notes |
|---|---|---|
| GET / POST | `/users` | filters `q, role, status`; create `{ email, fullName, role, password, groupIds? }` |
| GET / PATCH | `/users/:id` | patch `{ fullName?, role? }` |
| POST | `/users/:id/disable`, `/users/:id/enable` | disable revokes refresh tokens |
| PUT | `/users/:id/group-scopes` | `{ groupIds }` |
| POST | `/users/:id/reset-password` | `{ newPassword }` → 204 |

### Groups
| Method | Path | Permission |
|---|---|---|
| GET | `/groups` (`q, status`), `/groups/:id` (with stats) | groups:read |
| POST | `/groups` `{ name, description? }` | groups:create |
| PATCH | `/groups/:id` | groups:update |
| POST | `/groups/:id/deactivate`, `/groups/:id/activate` | groups:create |

### Schedules
| Method | Path | Permission |
|---|---|---|
| POST | `/schedules` `{ groupId, title, dayOfWeek (1=Mon…7=Sun), startLocalTime "HH:mm", endLocalTime, timezone?, effectiveFrom, effectiveUntil?, backfillPast? }` → schedule + `generation` | schedules:write |
| GET | `/schedules` (`groupId, status`), `/schedules/:id` (+ upcoming sessions) | schedules:read |
| GET | `/schedules/:id/occurrences/preview?from&to` (dry-run) | schedules:read |
| PATCH | `/schedules/:id` `{ title }` (timing is immutable) | schedules:write |
| POST | `/schedules/:id/end` `{ effectiveUntil }` → cancels untouched future occurrences, reports kept ones | schedules:write |
| POST | `/schedules/:id/deactivate` | schedules:write |
| POST | `/schedules/:id/generate?backfillPast=` | schedules:write |

### Sessions
| Method | Path | Permission |
|---|---|---|
| GET | `/sessions` (`groupId, status, origin, scheduleId, from, to, needsResolution`) | sessions:read |
| POST | `/sessions` (ad-hoc) `{ groupId, title, plannedStart, plannedEnd, timezone? }` | sessions:write |
| GET | `/sessions/:id` (+ attendanceSummary, admissionWindow, `held`) | sessions:read |
| PATCH | `/sessions/:id` `{ title?, plannedStart?, plannedEnd? }` (SCHEDULED, no attendance) | sessions:write |
| POST | `/sessions/:id/open` | sessions:write |
| POST | `/sessions/:id/close` | sessions:write |
| POST | `/sessions/:id/confirm-held` `{ openedAt?, closedAt?, note? }` (after the meeting) | sessions:write |
| POST | `/sessions/:id/cancel` `{ reason, note?, voidExistingAttendance? }` | sessions:write |
| POST | `/sessions/:id/reinstate` `{ note, reprocessRejectedEvents? }` | sessions:write |
| GET | `/sessions/:id/attendance?state=present\|absent\|all` | attendance:read |
| GET | `/sessions/:id/statistics` | attendance:read |

`reason` ∈ `PUBLIC_HOLIDAY, OFFICIAL_NYSC_ACTIVITY, VENUE_UNAVAILABLE, SECURITY, WEATHER, NOT_HELD, OTHER`.

### Members & memberships
| Method | Path | Permission |
|---|---|---|
| POST | `/members` `{ fullName, stateCode, groupId, joinedAt? }` (member + first membership) | members:write |
| GET | `/members` (`q, status, groupId, membership=current\|any, activeAt`) | members:read |
| GET / PATCH | `/members/:id` (`{ fullName?, stateCode? }`) | members:read / write |
| POST | `/members/:id/deactivate` `{ effectiveAt?, note? }` / `/members/:id/reactivate` | members:write |
| POST | `/members/:id/transfer` `{ toGroupId, effectiveAt?, note? }` | members:write (both groups) |
| GET | `/members/:id/memberships` | members:read |
| GET | `/members/:id/attendance?from&to` (raw records) | attendance:read |
| GET | `/memberships` (`memberId, groupId, activeAt`), `/memberships/:id` | members:read |
| POST | `/memberships` `{ memberId, groupId, joinedAt }` (re-join) | members:write |
| POST | `/memberships/:id/end` `{ leftAt?, reason, note? }` | members:write |
| PATCH | `/memberships/:id` `{ joinedAt?, leftAt? (null re-opens), note }` (correction) | members:write |

Membership `status` is derived: `ACTIVE` / `UPCOMING` / `ENDED`. End `reason` ∈ `SERVICE_COMPLETED, REMOVED, DATA_CORRECTION, OTHER` (`TRANSFERRED` and `MEMBER_DEACTIVATED` are set by those actions).

### Cards & assignments
| Method | Path | Permission |
|---|---|---|
| POST | `/cards` `{ cardUid, label? }` (stock, UNASSIGNED) | cards:write |
| GET | `/cards` (`status, cardUid, memberId`), `/cards/:id` (full history) | cards:read |
| GET | `/cards/history?cardUid=` | cards:read |
| POST | `/cards/:id/revoke` `{ reason: LOST\|DAMAGED\|STOLEN\|RETIRED\|OTHER, note? }` | cards:write |
| POST | `/cards/:id/reinstate` (REVOKED → UNASSIGNED) | cards:write |
| POST | `/card-assignments` `{ cardId \| cardUid, memberId, assignedAt? }` | cards:write |
| GET | `/card-assignments` (`memberId, cardId, status, activeAt`) | cards:read |
| POST | `/card-assignments/:id/end` `{ reason, endedAt?, note? }` | cards:write |
| POST | `/members/:id/card-replacement` `{ newCardId \| newCardUid, reason: LOST\|DAMAGED\|STOLEN\|OTHER, note? }` | cards:write |
| GET | `/members/:id/card-assignments` | cards:read |

### Attendance
| Method | Path | Permission |
|---|---|---|
| GET | `/attendance` (`sessionId, memberId, groupId, deviceId, from, to, source, status`) | attendance:read |
| GET | `/attendance/:id` (+ source event) | attendance:read |
| POST | `/attendance` `{ sessionId, memberId, note }` (manual) | attendance:correct |
| POST | `/attendance/:id/void` `{ note }`, `/attendance/:id/restore` `{ note }` | attendance:correct |
| GET | `/attendance/events` (`ackStatus, reason, resolution, deviceId, sessionId, memberId, groupId`) | attendance:read |
| POST | `/attendance/events/reprocess` `{ eventIds?, sessionId?, memberId?, deviceId?, reason? }` | attendance:correct |
| POST | `/attendance/events/:id/dismiss` `{ note }` | attendance:correct |

### Devices (dashboard)
| Method | Path | Permission |
|---|---|---|
| POST | `/devices` `{ deviceIdentifier, name, assignedGroupId }` → device + **one-time secret** | devices:manage |
| GET | `/devices` (`groupId, status, q`), `/devices/:id` (status, last seen/sync, last heartbeat) | devices:read |
| PATCH | `/devices/:id` `{ name?, assignedGroupId? }` | devices:manage |
| POST | `/devices/:id/activate`, `/suspend`, `/revoke`, `/decommission` `{ reason? }` | devices:manage |
| POST | `/devices/:id/credentials/rotate` → **one-time secret** | devices:manage |
| GET | `/devices/:id/sync-events?type=` | devices:read |

### Synchronization (device token) — see [DEVICE_SYNC.md](DEVICE_SYNC.md)
| Method | Path |
|---|---|
| POST | `/sync/token` (public) |
| GET | `/sync/snapshot` (ETag / If-None-Match) |
| POST | `/sync/attendance-batches` |
| POST | `/sync/heartbeat` |

### Reports — `reports:read` (CSV also needs `reports:export`)
| Method | Path |
|---|---|
| GET | `/reports/sessions/:id?format=json\|csv` |
| GET | `/reports/groups/:id?from&to&format=` (per session + totals, exclusions, warnings) |
| GET | `/reports/groups/:id/members?from&to&format=` (per member) |
| GET | `/reports/members/:id?from&to&format=` (per eligible session, per membership) |

### Audit & health
| Method | Path | Permission |
|---|---|---|
| GET | `/audit-logs` (`entityType, entityId, actorId, action (prefix), groupId, from, to`) | audit:read |
| GET | `/health` (liveness), `/health/ready` (DB + Redis) | public |

---

## Walkthrough

Copy-paste walkthrough with `curl` and `jq` (bash). It assumes the API is running and seeded.

```bash
API=http://localhost:3000/api/v1
TOKEN=$(curl -s -X POST $API/auth/login -H 'content-type: application/json' \
  -d '{"email":"admin@dla.local","password":"ChangeMe!2026"}' | jq -r .data.accessToken)
H=(-H "Authorization: Bearer $TOKEN" -H 'content-type: application/json')

# 1. Group + weekly schedule (Fridays 10:00–13:00 Lagos); sessions are generated 6 weeks ahead
GROUP=$(curl -s "${H[@]}" -X POST $API/groups -d '{"name":"DLA CDS Ikeja"}' | jq -r .data.id)
curl -s "${H[@]}" -X POST $API/schedules -d "{\"groupId\":\"$GROUP\",\"title\":\"Weekly CDS\",\"dayOfWeek\":5,\"startLocalTime\":\"10:00\",\"endLocalTime\":\"13:00\",\"effectiveFrom\":\"$(date +%F)\"}" | jq .data.generation

# 2. Member (joined 30 days ago) + card
MEMBER=$(curl -s "${H[@]}" -X POST $API/members -d "{\"fullName\":\"Adaeze Okafor\",\"stateCode\":\"LA/25A/1234\",\"groupId\":\"$GROUP\",\"joinedAt\":\"$(date -u -d '-30 days' +%FT%TZ)\"}" | jq -r .data.id)
curl -s "${H[@]}" -X POST $API/card-assignments -d "{\"cardUid\":\"04A1B2C3D4E5F6\",\"memberId\":\"$MEMBER\",\"assignedAt\":\"$(date -u -d '-30 days' +%FT%TZ)\"}" | jq .data.status

# 3. A meeting happening now (ad-hoc), opened by the admin
SESSION=$(curl -s "${H[@]}" -X POST $API/sessions -d "{\"groupId\":\"$GROUP\",\"title\":\"Today\",\"plannedStart\":\"$(date -u -d '-20 min' +%FT%TZ)\",\"plannedEnd\":\"$(date -u -d '+2 hours' +%FT%TZ)\"}" | jq -r .data.id)
curl -s "${H[@]}" -X POST $API/sessions/$SESSION/open | jq .data.status

# 4. Device: register (secret shown once), activate, authenticate
REG=$(curl -s "${H[@]}" -X POST $API/devices -d "{\"deviceIdentifier\":\"DLA-DEV-0001\",\"name\":\"Main reader\",\"assignedGroupId\":\"$GROUP\"}")
DEVICE=$(echo $REG | jq -r .data.device.id); SECRET=$(echo $REG | jq -r .data.credentials.secret)
curl -s "${H[@]}" -X POST $API/devices/$DEVICE/activate | jq .data.status
DTOKEN=$(curl -s -X POST $API/sync/token -H 'content-type: application/json' -d "{\"deviceIdentifier\":\"DLA-DEV-0001\",\"secret\":\"$SECRET\"}" | jq -r .data.accessToken)

# 5. Upload a tap — twice (the second is an idempotent replay)
BODY="{\"batchId\":\"b1\",\"events\":[{\"clientEventId\":\"ATT-123\",\"cardUid\":\"04A1B2C3D4E5F6\",\"capturedAt\":\"$(date -u -d '-5 min' +%FT%TZ)\",\"sessionId\":\"$SESSION\"}]}"
curl -s -X POST $API/sync/attendance-batches -H "Authorization: Bearer $DTOKEN" -H 'content-type: application/json' -d "$BODY" | jq .data.results
curl -s -X POST $API/sync/attendance-batches -H "Authorization: Bearer $DTOKEN" -H 'content-type: application/json' -d "$BODY" | jq .data.results

# 6. Close and report
curl -s "${H[@]}" -X POST $API/sessions/$SESSION/close | jq .data.status
curl -s "${H[@]}" $API/reports/sessions/$SESSION | jq .data.summary
curl -s "${H[@]}" "$API/reports/groups/$GROUP/members?format=csv"
```

(On macOS, replace `date -d '-30 days'` with `date -v-30d`.)
