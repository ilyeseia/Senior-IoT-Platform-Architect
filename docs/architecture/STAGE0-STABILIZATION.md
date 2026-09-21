# Stage 0 — Stabilization (no architectural change)

Scope approved 2026-09-20 from `ADVANCED-ARCHITECTURE-AUDIT.md` §29: fix the verified defects
B1, B3, B4, B7, B8, B12 (+ B13, found while verifying the firmware) on the current code before any evolution work.
B2 (no authentication) was closed **differently**: `origin/main` already contains the JWT identity module
(`IDENTITY-AUTH.md`), so the interim API-token guard written first was dropped. No schema change, no new
infrastructure. Each item cites the audit finding it closes.

## What changed

| Audit | Change | Where |
|---|---|---|
| **B1** | One command id end to end: `CommandsService` passes its `commands.id` to `MqttService.sendCommand(…, { id })`, so the DB row, the MQTT message and the device response share it. A second in-flight command with the same id is rejected. | `mqtt/mqtt.service.ts`, `commands/commands.service.ts` |
| **B2** | Authentication itself is provided by the JWT `IdentityModule` already on `origin/main` (global guard, `@Public()` opt-out). What Stage 0 adds: commanding an unregistered device is now a 404 instead of silently creating a registry row. | `commands/commands.service.ts` |
| **B3** | SSRF guard: device URLs must be `http://` on port 80/8080 with a private/Tailscale IPv4 literal (10/8, 172.16/12, 192.168/16, 100.64/10, minus 100.100.100.200), or a hostname listed in `LOCAL_API_ALLOWED_HOSTS`. Enforced at the API boundary **and** inside `LocalApiClient` on every call; redirects are not followed; responses > 256 KB are refused. | `esp-claw/local-target.ts`, `local-api-client.ts`, `devices/devices.service.ts` |
| **B4** | `MqttController` (`/mqtt/*`, unauthenticated, no audit, arbitrary `baseTopic`) removed. The command API takes the topic prefix from the device's registry row; a body containing `baseTopic` is rejected (400). Request bodies are validated with zod. | `mqtt/mqtt.module.ts`, `commands/commands.dto.ts`, `common/validation/parse-body.ts` |
| **B7** | On boot, commands still `pending` are closed as `timed_out` (their in-memory correlation died with the previous process). Assumes one backend instance, like the in-memory map itself. | `commands/commands.service.ts` |
| **B8** | `app.enableShutdownHooks()` so `OnModuleDestroy` (MQTT close, timers) runs on `SIGTERM`. | `main.ts` |
| **B13** (new, found while verifying the firmware) | `CommandsService.classify()` matched `"Denied agent cap call"`, which is only a device-side *log* line; the response the platform actually receives is `Error: cap '<name>' is not exposed to the LLM.`. Every real authorization denial was therefore stored as `failed`, never `rejected`. Now matches the real text (and the new `(reason=…)` suffix), legacy prefix still accepted. | `commands/commands.service.ts` |
| **B12** | `dotenv` declared as a dependency (lockfile updated); DB image pinned to `timescale/timescaledb:2.30.1-pg16` + healthcheck; new env vars documented; stale docs corrected. | `package.json`, `docker-compose.yml`, `.env.example`, README |

## Breaking changes (intentional)
* `POST /devices/:id/commands` no longer accepts `baseTopic` (400). Only `name`, `input?`, `timeoutMs?` (1 000–60 000 ms).
* `POST /devices/:id/commands` for a device that never sent a `status` message → **404** (was: auto-registered).
* `/mqtt/*` endpoints are gone. Use `/devices` and `/devices/:id/commands`.
* `POST /devices/:id/capabilities/refresh` rejects public/loopback/metadata hosts and `https://`.
* Compose image tag is pinned. If an existing volume was created by a different TimescaleDB minor,
  run `ALTER EXTENSION timescaledb UPDATE;` once after the first start.

## Verification
| Check | Result |
|---|---|
| `tsc --noEmit` / `nest build` | clean |
| Backend tests, on top of `origin/main` (`fcc8e15`) | **90 passed**: the 18 pre-existing + identity/twin suites already on `main`, plus SSRF matrix (23), `CommandsService` incl. id equality / registry topic / 404 / classification / orphan sweep (20), poller incl. twin merge (5), `DevicesService` SSRF (3), MQTT id-on-the-wire (integration, embedded broker) |
| Live dev Postgres (tailnet, PG 16.15 + TimescaleDB 2.30.0) | Read-only: `typeorm migration:show` with this code → migrations 1–6 all `[X]`, none pending; `telemetry` is a hypertable. Confirms code and live schema agree. |
| **Not verified** | The app was **not booted against the shared dev DB**: its boot sweep (B7) writes to `commands`, which another instance could be using. The sweep and controller wiring are covered by unit tests only. |

## Rollback
No schema change. `git revert` the Stage 0 commit(s); restore the compose tag if needed. The only
data-affecting behaviour is the boot sweep (turns stale `pending` rows into `timed_out`), which is
idempotent and loses nothing.

## Not in Stage 0 (still open, tracked in the audit)
B5 telemetry-through-commands scaling · B6 presence ordering race · B9 telemetry metric naming ·
B10 duplicate presence state · B11 remaining test gaps (controllers against a real DB) ·
RBAC / login throttling / twin hardening (see the audit's "Review of what landed on `main`").
