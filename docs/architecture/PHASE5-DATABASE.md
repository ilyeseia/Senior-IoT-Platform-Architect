# Phase 5 — Database

Status: **implemented, builds clean, existing test suite green**. Migrations have **not yet been
run against a real Postgres** in this environment — Docker Desktop wasn't available when this
phase was finished (see "What's not verified yet" below). Run the one command there before trusting
this in anything beyond code review.

## What exists

- **`docker-compose.yml`** — a single `postgres` service (`timescale/timescaledb:latest-pg16`),
  fixed dev credentials (`esp_claw` / `esp_claw_dev_only` / `esp_claw_platform`). Later phases will
  append `redis`/`backend`/`frontend`/`nginx` to the same file — not created ahead of the phase that
  needs them (same discipline as Phase 3/4).
- **`DATABASE_URL`** (`apps/backend/src/config/env.validation.ts`) is now **required**, unlike
  `MQTT_URL` which stays optional — Postgres is locally spinnable with fixed dev creds via the
  compose file above; there's no equivalent safe default for a real external broker.
- **`apps/backend/src/database/`**
  - `database.module.ts` — `TypeOrmModule.forRootAsync`, `synchronize: false`, `migrationsRun: true`
    (migrations only, never auto-sync — schema changes stay explicit and reversible).
  - `data-source.ts` — standalone TypeORM CLI `DataSource` for running/reverting migrations by hand.
  - `migrations/1700000000001-EnableTimescaleDb.ts` — `CREATE EXTENSION IF NOT EXISTS timescaledb;`
    only. No hypertable yet — there's no telemetry table to convert; adding one ahead of time would
    be exactly the "don't build ahead of the phase that needs it" pattern rejected earlier.
  - `migrations/1700000000002-CreateDevicesAndCommands.ts` — `devices`, `commands`
    (FK + indexes on `device_id`/`status`), `command_results`, with a full `down()` rollback.
- **`apps/backend/src/devices/`** — `Device` entity (id = real MAC-derived device_id, `baseTopic`,
  `online`, `lastSeenAt`, `firstSeenAt`, `updatedAt`); `DevicesService` with `findOrCreate()`
  (auto-registers a device on first contact) and an `@OnEvent("device.status")` handler that upserts
  presence; `DevicesController` (`GET /devices`, `GET /devices/:id`).
- **`apps/backend/src/commands/`** — `Command` entity (id = the *same* uuid as the wire protocol's
  `id`, so a DB row and a raw MQTT log entry correlate trivially), `CommandResult` entity;
  `CommandsService.dispatch()` — writes a `pending` row, calls `MqttService.sendCommand()`, then
  classifies the outcome:
  - `ok: true` → `succeeded`
  - `ok: false` and result starts with `"Denied agent cap call"` → `rejected` (the real string the
    `cap_mqtt` bridge returns for the auth-bypass this session found and fixed on the firmware side)
  - result contains `"timed out"` → `timed_out`
  - anything else `ok: false` → `failed`

  `CommandsController` exposes `POST /devices/:id/commands` and `GET /devices/:id/commands` — the
  real, DB-backed replacement for `MqttController`'s debug send endpoint from Phase 4 (which stays,
  unauthenticated and in-memory-only, as a low-level comparison tool while developing).
- **`MqttService`** now depends on `EventEmitter2` and emits `DEVICE_STATUS_EVENT`
  (`mqtt/mqtt.events.ts`) on every status message, instead of importing `DevicesService` directly —
  keeps `MqttModule` ignorant of who listens (Alerts/Automation in later phases can subscribe to the
  same event without `MqttService` changing).
- `app.module.ts` now wires `EventEmitterModule.forRoot()`, `DatabaseModule`, `DevicesModule`,
  `CommandsModule` alongside the existing modules.

## Verification performed

```
$ pnpm --filter @esp-claw/backend build
✓ exit 0

$ pnpm --filter @esp-claw/backend test
 ✓ test/mqtt/mqtt.service.integration.test.ts (5 tests)
 Test Files  1 passed (1)
      Tests  5 passed (5)
```

The 5 existing MQTT integration tests (local `aedes` broker, no real credentials) still pass
unchanged, including the one asserting `DEVICE_STATUS_EVENT` is emitted — proving the new
event-based decoupling didn't regress Phase 4's behavior.

## ⚠️ What's not verified yet — do this before trusting Phase 5

Docker Desktop was not running in this environment, so the following was **not** exercised live:

```bash
docker compose up -d postgres
pnpm --filter @esp-claw/backend exec typeorm-ts-node-commonjs migration:run -d src/database/data-source.ts
pnpm --filter @esp-claw/backend start
curl localhost:3000/devices
curl -X POST localhost:3000/devices/ecda3b4ff7d4/commands -H "Content-Type: application/json" -d '{"name":"get_current_time"}'
curl localhost:3000/devices/ecda3b4ff7d4/commands
```

Expected: the two `devices`/`command_results` tables get created, the app boots against real
Postgres, `GET /devices` lists the auto-registered device once it's sent a status message (or once
the command below runs), and the `POST` returns a `succeeded` command with `result` matching the
real device's reply — same round-trip as Phase 4, now with DB-backed history. Please run this and
tell me the result before Phase 6 — I will not claim it works until it's been seen running.

## Next

Phase 6 (ESP-Claw Integration): `capability-catalog.ts` + `local-api-client.ts`, reaching a device's
real local `/api/config` HTTP endpoint over the tailnet (decision #3 in PHASE1-ANALYSIS.md §K).
