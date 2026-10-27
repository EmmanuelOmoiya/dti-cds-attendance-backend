# Device synchronization protocol & integration guide

This document is the contract between the backend and the NFC attendance device firmware.

```
TAP → read UID → (optional) local roster lookup → assign clientEventId → PERSIST to local queue → feedback
online:  token → snapshot (If-None-Match) → upload batches (oldest first) → apply per-event ACKs → heartbeat
```

All requests use HTTPS. Base path: `/api/v1`. Bodies are JSON.

---

## 1. Provisioning (one-time, by an administrator)

1. `POST /devices` `{ deviceIdentifier, name, assignedGroupId }` → the response contains `credentials.secret`. **It is shown only once.** Only its SHA-256 hash is stored.
2. Load `deviceIdentifier` and `secret` onto the device (config file, serial console or QR code). Store the secret in the device's protected storage.
3. `POST /devices/:id/activate`. Devices start `PENDING` and cannot sync until activated.

`deviceIdentifier` is public (it can be printed on the case). **It is not a credential.**

Lifecycle: `PENDING → ACTIVE ⇄ SUSPENDED`, any of those `→ REVOKED` (stolen/compromised), and anything `→ DECOMMISSIONED`.
Only `ACTIVE` devices can sync. Revoking, decommissioning and rotating credentials take effect
immediately, including for tokens already issued.

## 2. Authentication — `POST /sync/token`

```http
POST /api/v1/sync/token
{ "deviceIdentifier": "DTI-DEV-0001", "secret": "dsk_…" }
```
```json
200 { "data": { "accessToken": "eyJ…", "tokenType": "Bearer", "expiresIn": 3600,
                "serverTime": "2026-11-13T08:00:00.000Z",
                "device": { "id": "…", "deviceIdentifier": "DTI-DEV-0001", "name": "Main reader", "groupId": "…" } } }
```

| Response | Meaning | Device action |
|---|---|---|
| 200 | ok | use `accessToken` as `Authorization: Bearer …` until it expires (1 h) |
| 401 `DEVICE_AUTH_FAILED` | unknown device or wrong secret (same response for both) | stop syncing; needs re-provisioning |
| 403 `DEVICE_NOT_ACTIVE` (`details.status`) | PENDING / SUSPENDED / REVOKED / DECOMMISSIONED | keep capturing offline, retry later (or stop if REVOKED/DECOMMISSIONED) |
| 403 `DEVICE_GROUP_INACTIVE` | group deactivated | as above |
| 429 | rate limited | back off |

Every request on the routes below re-checks: the token, that the device exists, that it is
`ACTIVE`, that the credential version is current, and that the group is active. A `401` on a sync
call means the token expired or the credentials were rotated, so request a new token. A `403` means
the device was suspended or revoked.

## 3. Download — `GET /sync/snapshot`

Everything needed to operate offline for the next `SYNC_LOOKAHEAD_DAYS` (14):

```json
{
  "data": {
    "snapshotVersion": "9f2c0e…",
    "serverTime": "2026-11-13T08:00:00.000Z",
    "device": { "id": "…", "deviceIdentifier": "DTI-DEV-0001", "name": "Main reader", "status": "ACTIVE" },
    "group":  { "id": "…", "name": "DTI CDS Ikeja", "status": "ACTIVE" },
    "config": { "maxBatchSize": 200, "recommendedSyncIntervalSec": 300,
                "sessionEarlyGraceMinutes": 60, "sessionCloseGraceMinutes": 30, "captureFutureToleranceSeconds": 300 },
    "roster": [
      { "cardUid": "04A1B2C3D4E5F6", "memberId": "…", "displayName": "Adaeze Okafor", "stateCode": "LA/25A/1234",
        "eligibleFrom": "2026-08-01T00:00:00.000Z", "eligibleUntil": null }
    ],
    "sessions": [
      { "id": "…", "title": "Weekly CDS", "occurrenceDate": "2026-11-13", "timezone": "Africa/Lagos",
        "plannedStart": "2026-11-13T09:00:00.000Z", "plannedEnd": "2026-11-13T12:00:00.000Z",
        "windowStart": "2026-11-13T08:00:00.000Z", "windowEnd": "2026-11-13T12:30:00.000Z", "status": "SCHEDULED" }
    ]
  }
}
```

- **Initial sync** is the first snapshot. **Incremental sync** sends `If-None-Match: "<ETag>"` and gets **`304 Not Modified`** (empty body) when nothing changed. The `ETag` is a hash of the content.
- `roster` contains active cards of active members whose membership in the device's group overlaps `[now − 1 day, now + 14 days]`. A card or member that disappears from the roster is no longer valid, so no tombstones are needed. `eligibleFrom`/`eligibleUntil` let the device give correct feedback for members joining or leaving while it is offline.
- `sessions` covers the device's group from yesterday to 14 days ahead, with **precomputed admission windows**, so the device needs no timezone logic. Cancelled sessions are included with `status: "CANCELLED"` so the device can show "meeting cancelled".
- The roster exists for **local feedback only**. The server re-validates every tap, so a stale roster never produces wrong attendance. It may produce a beep the server later rejects, which admins can review.

## 4. Capturing taps (device side)

For every tap:
1. Read the UID. Send it as upper- or lower-case hex; separators are accepted.
2. Generate a **stable `clientEventId`** (UUID recommended; 1–64 chars of `[A-Za-z0-9_-]`). It must never be reused for a different tap.
3. Record `capturedAt` from the device clock, ISO-8601 with an offset or `Z`.
4. Optionally record the `sessionId` the device believes is current: the snapshot session whose `[windowStart, windowEnd]` contains `capturedAt`. If none, omit it and the server resolves by time.
5. **Persist the event to local storage before giving feedback** (write-ahead). This way, a crash or power loss right after the beep cannot lose a tap the member believes was recorded.
6. Feedback is up to the device: known card → name / green; unknown card → "not recognised". **Still record and upload unknown-card taps.** The server stores them, and they can be recovered if the card is registered later.

Duplicate taps by the same person are harmless. The server answers `ALREADY_RECORDED`.

## 5. Upload — `POST /sync/attendance-batches`

```http
POST /api/v1/sync/attendance-batches
Authorization: Bearer <device token>
{
  "batchId": "b-2026-11-13-0001",
  "deviceTime": "2026-11-13T14:00:02.120Z",
  "snapshotVersion": "9f2c0e…",
  "events": [
    { "clientEventId": "0192f6c1-…", "cardUid": "04A1B2C3D4E5F6", "capturedAt": "2026-11-13T10:37:00+01:00", "sessionId": "…" }
  ]
}
```

Limits: 1 – `SYNC_MAX_BATCH_SIZE` (default **200**) events, request body ≤ 512 KB. Upload the oldest
events first.

Response (always one result per submitted event, **in submission order**):

```json
200 {
  "data": {
    "batchId": "b-2026-11-13-0001",
    "serverTime": "2026-11-13T14:00:03.004Z",
    "snapshotVersion": "a71d…",
    "results": [
      { "clientEventId": "e1", "status": "ACCEPTED", "attendanceRecordId": "…" },
      { "clientEventId": "e2", "status": "ALREADY_RECORDED", "attendanceRecordId": "…" },
      { "clientEventId": "e3", "status": "REJECTED", "reasonCode": "CARD_REVOKED" },
      { "clientEventId": "e4", "status": "RETRY", "reasonCode": "TRANSIENT_ERROR" }
    ],
    "summary": { "received": 4, "accepted": 1, "alreadyRecorded": 1, "rejected": 1, "retry": 1 }
  }
}
```

### Acknowledgement semantics

| `status` | Final? | Device action |
|---|---|---|
| `ACCEPTED` | yes | mark the event **synced** |
| `ALREADY_RECORDED` | yes | mark synced (the member was already present for that session) |
| `REJECTED` | yes | mark synced. The server has stored the event and its reason; resending cannot change the outcome |
| `RETRY` | no | keep it queued and resend later with the **same** `clientEventId` and payload |

If `snapshotVersion` in the response differs from the device's, download a new snapshot.

### Reject reasons

| `reasonCode` | Meaning |
|---|---|
| `INVALID_TIMESTAMP` | `capturedAt` before `CAPTURE_MIN_DATE` (reset clock) or more than 5 min in the future |
| `UNKNOWN_CARD` | UID not registered (or malformed) |
| `CARD_NOT_ASSIGNED` | card registered but not assigned to anyone at `capturedAt` |
| `CARD_REVOKED` | card's assignment had ended / card revoked at `capturedAt` |
| `MEMBER_INACTIVE` | member deactivated before `capturedAt` |
| `DEVICE_NOT_AUTHORIZED` | `sessionId` belongs to another group |
| `SESSION_CANCELLED` | the meeting was cancelled |
| `NO_MATCHING_SESSION` | no session of the device's group covers `capturedAt` |
| `SESSION_NOT_OPEN` | `capturedAt` outside the session's admission window (too early, or after attendance closed) |
| `MEMBER_NOT_IN_GROUP` | the member never belonged to this group |
| `NOT_ELIGIBLE_FOR_SESSION` | the member had not yet joined, or had already left, when the session started |
| `DUPLICATE_EVENT` | this `clientEventId` was already used for a *different* tap (the original is kept) |

### Whole-request failures

| Response | Meaning | Device action |
|---|---|---|
| network error / timeout / 5xx | outcome unknown | resend the **same events** later. Always safe |
| 400 `VALIDATION_FAILED` | malformed payload (`details` lists fields) | fix firmware; don't loop |
| 401 / 403 | see §2 | get a new token / stop |
| 413 `BATCH_TOO_LARGE` | too many events | split into smaller batches |
| 429 | rate limited | back off |

### Why retries are always safe

The server stores each tap under `UNIQUE(deviceId, clientEventId)`. Replaying a stored tap returns
**exactly the stored acknowledgement**, with the same status and the same `attendanceRecordId`, without
writing anything. Two devices recording the same member are resolved by
`UNIQUE(sessionId, memberId)`: one gets `ACCEPTED`, the other `ALREADY_RECORDED`. Each tap is
committed in its own transaction, so a connection drop mid-batch leaves the processed taps committed
and the resend completes the rest.

```
Device                         Backend                       DB
  │ POST batch [ATT-123] ────────▶ insert event + record ───────▶ commit
  │ ✗ response lost
  │ POST batch [ATT-123] ────────▶ (deviceId, ATT-123) exists → stored ack
  │ ◀──────── 200 ACCEPTED, same recordId
  │ mark ATT-123 synced
```

### Time rules (offline-first)

The backend evaluates every rule at the tap's `capturedAt`, never at upload time. A tap at 11:37
during an open meeting, uploaded at 14:00 after the meeting closed, is **accepted** and flagged
`lateSync`. A tap captured after attendance closed is rejected as `SESSION_NOT_OPEN`.

The device clock therefore matters. Keep it synchronised:
- Use `serverTime` from the token, snapshot, upload and heartbeat responses to correct drift.
- Send `deviceTime` in uploads and heartbeats. The server records the skew per event and per sync.
- A device whose clock reset (e.g. to 1970) after a power loss produces `INVALID_TIMESTAMP` rejections. They are kept for review.

## 6. Heartbeat — `POST /sync/heartbeat`

```json
{ "deviceTime": "…", "firmwareVersion": "1.0.3", "batteryPct": 76, "pendingEvents": 3,
  "lastCaptureAt": "…", "bootId": "boot-7", "snapshotVersion": "9f2c…" }
```
→ `{ "serverTime", "snapshotVersion", "clockSkewMs" }`. Shown to admins in `GET /devices/:id`
(`lastStatus`, `reportedPendingEvents`). Send one after every sync and every few minutes while online.

## 7. Recommended device loop

```
on boot: load queue + last snapshot from storage
every N minutes while online (and immediately when connectivity returns):
  if no valid token → POST /sync/token
  GET /sync/snapshot with If-None-Match → replace roster/sessions on 200
  while queue has unsynced events:
      batch = oldest ≤ maxBatchSize unsynced events
      POST /sync/attendance-batches
      for each result: if status != RETRY → mark synced
      on network error/5xx: stop, retry later with the same batch
  POST /sync/heartbeat
prune synced events older than ~30 days
```

## 8. What administrators see

- `GET /devices/:id`: status, last seen, last sync, last upload summary, last heartbeat.
- `GET /devices/:id/sync-events`: every token/snapshot/upload/heartbeat with counts, duration, skew and errors.
- `GET /attendance/events?ackStatus=REJECTED`: rejected taps with reasons. These can be **dismissed** or **reprocessed** after data is fixed (`POST /attendance/events/reprocess`), e.g. after registering a card retrospectively or correcting a join date.
- Audit log: `device.authenticated`, `device.auth_failed` (reason, never the secret), `sync.batch_processed`.
