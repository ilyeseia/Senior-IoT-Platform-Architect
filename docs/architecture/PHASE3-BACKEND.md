# Phase 3 — Backend (skeleton)

Status: **implemented and verified running**, scope deliberately narrow. Per the brief's own
phase list (item 36), this phase is *just* the backend application shell — MQTT (Phase 4),
the real database (Phase 5), and deeper ESP-Claw capability integration (Phase 6) are named,
separate phases and are **not** pulled forward here, even though PHASE2's own "Next" section had
loosely suggested a bigger first slice. The narrower scope matches the brief's explicit rule:
don't move to the next phase before the current one is confirmed sound, and don't build ahead of
what's been named.

## What exists

- **Monorepo tooling**: pnpm workspaces (`apps/*`, `packages/*`), a shared `tsconfig.base.json`,
  root `.gitignore`/`.env.example`.
- **`packages/esp-claw-protocol`** — pure TypeScript, zero framework dependency, the real
  ESP-Claw MQTT topic scheme and command/response/status envelope shapes (verified against the
  actual firmware and a real broker this session — see `PHASE1-ANALYSIS.md §0/§C` and this
  package's doc-comments, which cite the exact log lines that proved each shape). **17/17 unit
  tests pass**, including the trickiest real case: a tenant-scoped, multi-segment `base_topic`
  (`espclaw/acme-farms/...`) round-tripping correctly through `buildTopic`/`parseTopic`.
- **`apps/backend`** — a real, running NestJS application:
  - `GET /health` → `{status, uptimeSeconds, timestamp}`.
  - `GET /esp-claw/topics?deviceId=...&baseTopic=...` — a debug endpoint exercising the real
    `TopicService` (the adapter-layer seam every future module must go through instead of
    hand-building topic strings). Verified live with the actual device id used on real hardware
    all session (`ecda3b4ff7d4`), both with and without tenant scoping, and a 400 on a missing
    `deviceId`.
  - Env validation (`zod`) fails fast on a malformed `.env`, but only `PORT`/`NODE_ENV` are
    required right now — `MQTT_URL`/`DATABASE_URL`/`REDIS_URL`/`JWT_SECRET` are validated for
    *shape* if present but optional, since nothing in Phase 3 connects to them yet. Each becomes
    required as its own phase (4/5/10) actually wires it up.

## What deliberately does not exist yet

No `devices/`, `commands/`, `telemetry/`, `ota/`, `automation/`, `agents/`, `alerts/`,
`notifications/`, or `audit/` modules — creating them now, empty, would be scaffolding with no
content (the brief's own item 43 rule against "حلول مؤقتة" applies here too: an empty stub
pretending to be a module is a kind of placeholder). They get created *with real logic* in the
phase that actually needs them:

| Module | Lands in |
|---|---|
| `mqtt/` (CloudAMQP connection) | Phase 4 |
| `database/` + `devices/` (real registry) | Phase 5 |
| `esp-claw/capability-catalog.ts`, `esp-claw/local-api-client.ts` | Phase 6 |
| `commands/` (state machine, correlation via Redis) | Phase 4 (needs MQTT) + Phase 5 (needs DB for history) |
| `agents/`, `ota/`, `automation/`, `alerts/`, `notifications/`, `audit/` | their own named phases |

## Verification performed

```
$ pnpm install                    # 385 packages, workspace-linked
$ pnpm --filter @esp-claw/protocol build   # tsc — clean
$ pnpm --filter @esp-claw/protocol test    # vitest — 17/17 passed
$ pnpm --filter @esp-claw/backend build    # nest build — clean
$ node apps/backend/dist/main.js
  [Nest] Starting Nest application...
  [Nest] Mapped {/health, GET} route
  [Nest] Mapped {/esp-claw/topics, GET} route
  [backend] listening on :3000 (env=development)

$ curl localhost:3000/health
  {"status":"ok","uptimeSeconds":18,"timestamp":"2026-09-15T21:02:08.258Z"}

$ curl "localhost:3000/esp-claw/topics?deviceId=ecda3b4ff7d4"
  {"status":"espclaw/ecda3b4ff7d4/status",
   "command":"espclaw/ecda3b4ff7d4/command",
   "response":"espclaw/ecda3b4ff7d4/response"}

$ curl "localhost:3000/esp-claw/topics?deviceId=ecda3b4ff7d4&baseTopic=espclaw/acme-farms"
  {"status":"espclaw/acme-farms/ecda3b4ff7d4/status", ...}   # tenant scoping confirmed over HTTP

$ curl -o /dev/null -w '%{http_code}' "localhost:3000/esp-claw/topics"
  400   # missing deviceId correctly rejected
```

## How to run it

```bash
pnpm install
cp .env.example apps/backend/.env
pnpm --filter @esp-claw/protocol build
pnpm --filter @esp-claw/backend build
pnpm --filter @esp-claw/backend start        # or: pnpm dev:backend for watch mode
```

## Next

Phase 4 (MQTT Integration): add `apps/backend/src/mqtt/` — a single shared connection to the
existing CloudAMQP broker (decision #1), subscribing to `+/+/status` (or a tenant-aware broad
subscription + `TopicService.parse()`, per the wildcard caveat documented in
`packages/esp-claw-protocol/src/topics.ts`) to start tracking real device presence.
