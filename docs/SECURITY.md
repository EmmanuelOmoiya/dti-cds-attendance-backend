# Security

This document describes what is implemented and what still has to be hardened. The MVP is **not**
claimed to be production-secure. See [Not yet hardened](#not-yet-hardened).

## Dashboard authentication

| Aspect | Implementation |
|---|---|
| Passwords | argon2id (19 MiB, t=2, p=1); min 10 / max 128 chars. Constant-time dummy verify for unknown emails |
| Access token | JWT HS256, 15 min, claims `sub`, `role`, `typ:"user"` |
| Refresh token | opaque 256-bit random value, stored as SHA-256, 7 days, **single-use with rotation**. Re-using a rotated token revokes the whole token family (theft detection) and is audited |
| Per-request check | the user is re-read from the database on every request, so disabling a user or removing a group scope takes effect immediately |
| Login errors | the same `401 INVALID_CREDENTIALS` for unknown email and wrong password; disabled accounts get 403 only after a correct password |
| Password change / reset / disable | revokes all of the user's refresh tokens |
| Rate limits | login & refresh 10/min per IP (configurable) |

## Authorization (RBAC + group scope)

Two layers:
1. **Permission guard.** The route declares `@RequirePermissions(...)`, checked against a static role matrix (`src/auth/permissions.ts`).
2. **AccessScope.** SUPER_ADMIN is global. CDS_ADMIN and LGI_VIEWER see only the groups in their `UserGroupScope`. Every query and every single-entity load is filtered through it. **Out-of-scope resources return 404**, so other groups' data cannot be enumerated.

| Permission | SUPER_ADMIN | CDS_ADMIN (scoped) | LGI_VIEWER (scoped) |
|---|:-:|:-:|:-:|
| users:manage | ✅ | | |
| groups:create (create/activate/deactivate) | ✅ | | |
| groups:read | ✅ | ✅ | ✅ |
| groups:update | ✅ | ✅ | |
| schedules:read / write | ✅ | ✅ / ✅ | ✅ / |
| sessions:read / write | ✅ | ✅ / ✅ | ✅ / |
| members:read / write (incl. memberships, transfers) | ✅ | ✅ / ✅ | ✅ / |
| cards:read / write | ✅ | ✅ / ✅ | ✅ / |
| attendance:read / correct | ✅ | ✅ / ✅ | ✅ / |
| reports:read / export | ✅ | ✅ / ✅ | ✅ / ✅ |
| devices:read / manage | ✅ | ✅ / ✅ | |
| audit:read | ✅ | ✅ (own groups' entries) | |

Scope details:
- A member is visible to scoped users if they ever had a membership in one of the user's groups.
- A transfer needs scope over both groups.
- Blank card stock is shared, so unassigned cards are visible to all CDS admins. Assignment history only shows holders the user is allowed to see.

## Device trust

| Requirement | Implementation |
|---|---|
| Identifier ≠ credential | `deviceIdentifier` is public; authentication needs the per-device **secret** (256-bit random, `dsk_` prefix) |
| Secret storage | only SHA-256(secret) is stored, compared in constant time. The secret is returned once, at registration or rotation, and never again |
| Token | `POST /sync/token` → JWT HS256 with a **separate secret** (`DEVICE_JWT_SECRET`), `typ:"device"`, `cv` = credential version, 1 h TTL |
| Every sync request | device exists · credential version current · status `ACTIVE` (so not PENDING, SUSPENDED, REVOKED or DECOMMISSIONED) · group active |
| Remote kill switch | suspend / revoke / decommission act **immediately**, even on tokens already issued. Revoke and decommission also bump the credential version |
| Rotation | new secret, credential version + 1. The old secret and every old token stop working immediately |
| Group isolation | uploads can only resolve sessions of the device's own group. Claiming another group's session → `DEVICE_NOT_AUTHORIZED` |
| Token separation | user tokens are refused on `/sync/*`, device tokens everywhere else (different secrets and `typ`) |
| History | attendance from a revoked or decommissioned device is kept intact |
| Audit | `device.registered/activated/suspended/revoked/decommissioned/credentials_rotated`, `device.authenticated`, `device.auth_failed` (reason: UNKNOWN_DEVICE / INVALID_CREDENTIAL / DEVICE_NOT_ACTIVE / CREDENTIAL_SUPERSEDED / GROUP_INACTIVE). Failures also appear in the device's sync history |
| Rate limits | device token 20/min, sync 120/min per IP (configurable) |

## Data protection

- **Minimal personal data.** Members have name, state code and memberships only. NFC cards carry only their UID. The device roster carries name + state code for on-device feedback.
- **No secrets in logs.** pino redacts `authorization`, `cookie`, `password`, `secret`, `refreshToken`, `accessToken`. Card UIDs are masked in application logs. Audit metadata goes through a recursive redaction of credential-like keys.
- **Input validation.** Whitelisted DTOs (unknown fields → 400), strict ISO-8601, UUID path params, bounded strings and arrays, JSON body ≤ 512 KB.
- **SQL injection.** All access goes through Prisma. Raw report SQL uses tagged-template parameters.
- **HTTP hardening.** `helmet` security headers, `x-powered-by` disabled, CORS restricted to `CORS_ORIGINS` (off by default).
- **Errors.** Responses carry a code, a message and a request id. Stack traces and SQL are logged, never returned.
- **CSV exports** are protected against spreadsheet formula injection.
- **Integrity.** The database enforces uniqueness, non-overlap and append-only rules (see [DATABASE.md](DATABASE.md)).

## Operational requirements

- **TLS is mandatory** in any real deployment. Terminate it at a reverse proxy and set `TRUST_PROXY_HOPS`.
- Generate long random `JWT_ACCESS_SECRET` and `DEVICE_JWT_SECRET`. They must differ in production (enforced at boot).
- Keep `.env` out of version control (`.gitignore` covers it). Use the platform's secret store in production.
- Disable or protect Swagger (`SWAGGER_ENABLED=false`) in production.
- Set `REDIS_URL` when running more than one API instance, so rate limits are shared.
- Change the seeded admin password immediately, or seed with a strong `SEED_ADMIN_PASSWORD`.

## Not yet hardened

| Gap | Risk | Suggested remedy |
|---|---|---|
| No MFA for administrators | account takeover via phished password | TOTP/WebAuthn for SUPER_ADMIN and CDS_ADMIN |
| Refresh token returned in the response body | XSS in the dashboard could steal it | httpOnly, Secure, SameSite cookie once the dashboard domain is fixed |
| Plain NFC UIDs | UIDs can be read and cloned, enabling buddy-punching | supervised tapping now; NTAG 424 DNA (SUN/AES-CMAC) verification later |
| Secrets in environment variables | leakage via host compromise | secret manager, JWT key rotation (`kid`) |
| Device secret at rest on the device | a stolen device leaks its secret | revoke immediately (supported); encrypted storage on the device |
| Account lockout | only rate limiting today | progressive delays per account |
| No WAF / DDoS protection | availability | platform-level protection |
| Backups not automated | data loss | managed PostgreSQL with PITR; tested restores |
| No data-retention / NDPR review | compliance | retention policy for members who passed out; DPIA |
| No penetration test | unknown vulnerabilities | external test before go-live |
| Audit logs are in the same database | an attacker with DB access could tamper (triggers can be dropped) | ship audit events to a write-once store |
