# DLA CDS Attendance — Backend

Offline-first NFC attendance backend for Digital Literacy 4 All (DLA) CDS groups.

NFC readers record taps locally while offline. When connectivity returns, they synchronise in
batches. The backend is the source of truth for groups, recurring schedules, sessions,
time-bounded memberships, card assignments, devices, attendance and audit history. It serves a
REST API for the web dashboard and a separate, device-authenticated sync API for the readers.

| | |
|---|---|
| Stack | Node.js 22+/24 · TypeScript · NestJS 11 · PostgreSQL 17 · Prisma 7 · Redis (rate limiting) · Docker |
| API | REST, versioned under `/api/v1`, OpenAPI at `/api/docs` |
| Tests | 163 automated tests (unit, integration against PostgreSQL, HTTP end-to-end) |

## Documentation

| Document | Contents |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System design, modules, domain model, session lifecycle, business rules |
| [docs/API.md](docs/API.md) | Endpoint reference, conventions, error codes, curl walkthrough |
| [docs/DATABASE.md](docs/DATABASE.md) | Schema, constraints, indexes, migrations |
| [docs/DEVICE_SYNC.md](docs/DEVICE_SYNC.md) | Synchronization protocol and device integration guide |
| [docs/SECURITY.md](docs/SECURITY.md) | Auth, RBAC, device trust, hardening still required |
| [docs/TESTING.md](docs/TESTING.md) | How to run the tests and what they cover |
| [docs/ASSUMPTIONS.md](docs/ASSUMPTIONS.md) | Decisions made where requirements were silent |

---

## Quick start (local development)

Prerequisites: **Node.js ≥ 22.12** (24 recommended), **Docker** with Docker Compose.

```bash
# 1. Install dependencies (also generates the Prisma client)
npm install

# 2. Configuration
cp .env.example .env            # defaults work for local development

# 3. Start PostgreSQL, the test database and Redis
docker compose up -d postgres postgres-test redis

# 4. Create the schema (applies all migrations, including hand-written constraints)
npm run db:migrate

# 5. Create the first SUPER_ADMIN (from SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD in .env)
npm run db:seed                 # set SEED_DEMO_DATA=true in .env for a demo group, members, cards and a device

# 6. Run the API
npm run start:dev               # http://localhost:3000/api/v1/health · docs at http://localhost:3000/api/docs
```

Log in with the seeded admin (`admin@dla.local` / `ChangeMe!2026` by default; change these in `.env`):

```bash
curl -s -X POST localhost:3000/api/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"admin@dla.local","password":"ChangeMe!2026"}'
```

Use the returned `accessToken` as `Authorization: Bearer <token>`. In Swagger UI, click **Authorize**.
[docs/API.md](docs/API.md#walkthrough) has a full walkthrough, from creating a group to a device upload and a report.

### Everything in Docker

```bash
docker compose up -d --build    # postgres, redis and the API on :3000
docker compose logs -f api
```

The API container runs `prisma migrate deploy`, then the idempotent seed, then starts the server.

## Commands

| Command | Purpose |
|---|---|
| `npm run start:dev` | API with watch mode |
| `npm run build` / `npm start` | Compile to `dist/` / run compiled build |
| `npm run db:migrate` | Apply migrations (`prisma migrate deploy`) |
| `npm run db:migrate:dev` | Create a new migration during development |
| `npm run db:seed` | Create the first SUPER_ADMIN (and demo data if `SEED_DEMO_DATA=true`) |
| `npm test` | Unit tests (no database needed) |
| `npm run test:integration` | Integration tests (needs `postgres-test`) |
| `npm run test:e2e` | HTTP end-to-end tests (needs `postgres-test`) |
| `npm run test:all` | Everything |
| `npm run lint:types` | Type-check |

> **Never use `prisma db push`.** Integrity rules such as overlap-prevention constraints and the
> append-only triggers live in a hand-written migration that `db push` would skip.

## Environment variables

Every variable is validated at startup ([src/config/app-config.ts](src/config/app-config.ts)), so a misconfigured app refuses to boot.

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | — (required) | PostgreSQL connection string |
| `REDIS_URL` | unset | Redis for shared rate-limit counters. Without it, limits are in-memory (single instance only) |
| `JWT_ACCESS_SECRET` | — (required, ≥ 32 chars) | Signs dashboard access tokens |
| `DEVICE_JWT_SECRET` | — (required, ≥ 32 chars, must differ in production) | Signs device tokens |
| `JWT_ACCESS_TTL_SECONDS` | 900 | Access token lifetime |
| `REFRESH_TOKEN_TTL_DAYS` | 7 | Refresh token lifetime |
| `DEVICE_TOKEN_TTL_SECONDS` | 3600 | Device token lifetime |
| `PORT` | 3000 | HTTP port |
| `NODE_ENV` | development | `development` / `test` / `production` |
| `CORS_ORIGINS` | unset (CORS off) | Comma-separated dashboard origins |
| `SWAGGER_ENABLED` | true | Serve `/api/docs` (disable or protect in production) |
| `LOG_LEVEL` | info | pino log level |
| `TRUST_PROXY_HOPS` | 0 | Reverse proxies in front of the API (for real client IPs) |
| `APP_TIMEZONE` | Africa/Lagos | Default timezone for schedules, ad-hoc sessions and report dates |
| `SESSION_GENERATION_HORIZON_WEEKS` | 6 | How far ahead expected sessions are generated |
| `SESSION_EARLY_GRACE_MINUTES` | 60 | Taps this long before the planned start count |
| `SESSION_CLOSE_GRACE_MINUTES` | 30 | Attendance closes this long after the planned end (auto-close point) |
| `SESSION_UNRESOLVED_AFTER_HOURS` | 24 | A meeting with no admin decision becomes UNRESOLVED this long after its end |
| `JOBS_ENABLED` / `JOBS_CRON` | true / `*/15 * * * *` | Periodic session maintenance |
| `SYNC_MAX_BATCH_SIZE` | 200 | Max events per upload |
| `SYNC_LOOKAHEAD_DAYS` | 14 | How far ahead the device snapshot covers |
| `CAPTURE_FUTURE_TOLERANCE_SECONDS` | 300 | Allowed device clock drift into the future |
| `CAPTURE_MIN_DATE` | 2024-01-01 | Taps stamped before this are treated as a reset clock |
| `THROTTLE_*_PER_MINUTE` | 300 / 10 / 20 / 120 | Rate limits: default / login / device token / sync |
| `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` | admin@dla.local / — | First SUPER_ADMIN (seed only) |
| `SEED_DEMO_DATA` | false | Seed a demo group, schedule, members, cards and device |

Generate secrets with `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`.

## Project layout

```
src/
  config/          validated environment (AppConfig)
  common/          errors, HTTP envelope, pagination, Prisma, request context, crypto, time helpers
  auth/            login/refresh, JWT + permission guards, AccessScope (group scoping)
  users/           dashboard users & group scopes
  groups/          CDS groups
  schedules/       recurring schedules, occurrence calculator, session generation
  sessions/        session lifecycle, timing/window rules
  members/         members, time-bounded group memberships, eligibility
  cards/           card inventory, time-bounded card assignments, replacement
  attendance/      admission policy, ingestion (idempotent), records, event inbox, reprocessing
  devices/         device registry, lifecycle, credentials
  synchronization/ device auth, snapshot, batch upload, heartbeat
  reports/         eligibility-based statistics, CSV export
  audit/           append-only audit log
  jobs/            periodic session maintenance (generate / auto-close / mark unresolved)
  health/          liveness & readiness
  cli/seed.ts      first admin + demo data
prisma/            schema + migrations (incl. hand-written integrity constraints)
test/              unit / integration / e2e
```

## Deployment notes

- Build the image with the provided `Dockerfile`. It is multi-stage, runs as a non-root user and has a health check.
- On start, the container applies migrations (`prisma migrate deploy`). Run a single instance first, or run migrations as a separate release step.
- Terminate **TLS** at a reverse proxy or load balancer. Devices and the dashboard must use HTTPS. Set `TRUST_PROXY_HOPS` accordingly.
- Use a managed PostgreSQL 14+ with the `btree_gist` extension available (the migration creates it).
- Set strong, distinct `JWT_ACCESS_SECRET` / `DEVICE_JWT_SECRET`, `SWAGGER_ENABLED=false` (or protect it), `CORS_ORIGINS` to the dashboard origin, and `REDIS_URL` when running more than one instance.
- Ship structured JSON logs (stdout) to your log platform. Back up the database (see [docs/SECURITY.md](docs/SECURITY.md#not-yet-hardened)).

## Known limitations

See [docs/ASSUMPTIONS.md](docs/ASSUMPTIONS.md#known-limitations) and [docs/SECURITY.md](docs/SECURITY.md#not-yet-hardened). In short:
- no admin MFA
- no anti-cloning card verification (plain UIDs)
- no PDF reports yet (the formatter interface is ready)
- incremental roster sync is full-snapshot + ETag rather than a change feed
- the device firmware itself is out of scope
