# Phase 2 — Repository Structure

Status: **structure/skeleton proposal only** — no application logic yet (that's Phase 3). Builds
directly on the confirmed decisions in [PHASE1-ANALYSIS.md §K](./PHASE1-ANALYSIS.md#k-confirmed-decisions-post-review).

## Deviations from the brief's example structure, and why

The original brief (item 37) suggested `backend/ frontend/ mqtt/ database/ firmware/ device-sdk/
shared/ docker/ docs/ tests/ scripts/ monitoring/`. Three changes, each justified by a confirmed
decision or a §0 ground-truth finding:

- **No `mqtt/` service folder.** Decision #1: no self-hosted broker. CloudAMQP is an external
  dependency (host/port/credentials in `.env`), not something this repo runs or configures.
- **No `firmware/` folder holding source.** ESP-Claw is its own separate repository (rule #38 —
  we don't vendor or duplicate its source here). What this platform *does* own is uploaded OTA
  **binaries** (data, not source) and their metadata (`firmware.sha256`, `storage_url`) — that's a
  storage volume/bucket referenced from the DB, not a source folder.
- **No standalone `device-sdk/`.** There's no separate device-side SDK being authored by this
  repo — ESP-Claw already *is* the device-side implementation. What needs to be shared is the
  **protocol contract** (topic format, command/response envelope shape, capability-catalog
  types) — that lives in `packages/esp-claw-protocol/`, consumed by the backend's adapter layer.
- **Monorepo (`apps/` + `packages/`)** instead of flat `backend/`/`frontend/` siblings, so the
  backend (NestJS) and frontend (Next.js) share one `shared-types` package — the single source of
  truth for `DeviceDTO`, `CommandEnvelope`, `CapabilityDescriptor`, etc. Type drift between a
  backend DTO and a frontend interface is a real, common bug class in systems shaped like this one;
  a monorepo with a shared package removes the whole category of bug rather than relying on
  discipline to keep two hand-written copies in sync.

Everything else (`docs/`, `scripts/`, `tests/`, `monitoring/`, `docker-compose.yml`,
`.env.example`) is kept as proposed, because they were already right.

## Proposed tree

```text
esp-claw-platform/
├── apps/
│   ├── backend/                        # NestJS: API, MQTT client, WS gateway, all "services" as modules
│   │   ├── src/
│   │   │   ├── modules/
│   │   │   │   ├── auth/               # JWT, RBAC guards, org-scoping (§G)
│   │   │   │   ├── devices/            # Device Registry Service (§B)
│   │   │   │   ├── device-groups/      # groups + bulk fan-out (item 19)
│   │   │   │   ├── device-config/      # NEW (decision #3): proxies GET/POST /api/config
│   │   │   │   │                       #   over the tailnet; write-only for secret fields
│   │   │   │   ├── commands/           # Command Service — the ONLY module allowed to publish
│   │   │   │   │                       #   to a device's `command` topic (§C state machine)
│   │   │   │   ├── telemetry/          # Telemetry/Ingest Service (MQTT subscriber → Timescale)
│   │   │   │   ├── ota/                # OTA Service (rollout, progress, firmware registry)
│   │   │   │   ├── automation/         # Automation Engine (item 15), issues via commands/ module
│   │   │   │   ├── agents/             # AI Agent Mgmt — vault-backed, push-only (decision #4)
│   │   │   │   ├── alerts/             # threshold/offline/custom-event rules (item 14)
│   │   │   │   ├── notifications/      # Telegram/email/web-push dispatch (item 30)
│   │   │   │   └── audit/              # audit_logs writer + query API
│   │   │   ├── esp-claw/               # ★ the Integration/Adapter Layer (§B) — ALL ESP-Claw-
│   │   │   │   │                       #   specific knowledge lives here and nowhere else
│   │   │   │   ├── topics.ts           #   {base_topic}/{device_id}/{leaf} build + parse
│   │   │   │   ├── envelope.ts         #   command/response JSON shape (§C), (de)serializers
│   │   │   │   ├── capability-catalog.ts  # maps claw_cap introspection → device_capabilities rows
│   │   │   │   └── local-api-client.ts #   thin client for the device's real /api/config etc.
│   │   │   │                           #   over the tailnet (decision #2/#3)
│   │   │   ├── mqtt/                   # single shared CloudAMQP connection (decision #1)
│   │   │   ├── websocket/              # WS Gateway, Redis pub/sub fan-out (§B)
│   │   │   ├── database/               # ORM entities + migrations (§D schema)
│   │   │   ├── common/                 # guards, interceptors, decorators, filters
│   │   │   └── main.ts
│   │   ├── test/
│   │   ├── Dockerfile
│   │   └── package.json
│   │
│   └── frontend/                       # Next.js dashboard
│       ├── src/
│       │   ├── app/                    # fleet overview, devices/[id], groups, ota, alerts,
│       │   │                           #   automation, settings (device-config), auth
│       │   ├── components/
│       │   ├── lib/                    # REST client, WS hook, shared-types re-exports
│       │   └── styles/
│       ├── Dockerfile
│       └── package.json
│
├── packages/
│   ├── shared-types/                   # DeviceDTO, CommandEnvelope, AlertDTO, ... (backend ⇄ frontend)
│   └── esp-claw-protocol/              # topic/envelope constants + Zod/JSON-Schema validators,
│                                       #   imported by apps/backend/src/esp-claw/
│
├── docker/
│   ├── postgres/                       # init: enable TimescaleDB + pgcrypto extensions
│   ├── redis/
│   └── nginx/                          # reverse proxy; TLS cert mounted from `tailscale cert`
│                                       #   output (decision #2) — no Let's Encrypt/self-signed
│
├── docs/
│   └── architecture/
│       ├── PHASE1-ANALYSIS.md
│       └── PHASE2-REPOSITORY-STRUCTURE.md
│
├── scripts/                            # DB seed, admin-user bootstrap, provisioning helper CLI
├── tests/
│   └── e2e/
├── monitoring/                         # placeholder for V2 (§I) — Prometheus/Grafana/Loki configs
│
├── docker-compose.yml                  # postgres+timescale, redis, backend, frontend, nginx
│                                       #   (no broker container — decision #1)
├── .env.example
├── package.json                        # workspace root
├── pnpm-workspace.yaml
├── .gitignore
├── LICENSE
└── README.md
```

## Why this satisfies the "adapter, not invented API" rule structurally

Every module under `apps/backend/src/modules/` depends on `esp-claw/` interfaces
(`buildTopic()`, `CommandEnvelope`, `LocalApiClient`), never on raw MQTT topic strings or raw
`fetch()` calls to a device. If ESP-Claw's real protocol changes (e.g. a future `cap_telemetry`
leaf is added, or MQTT5 is enabled), exactly one directory (`esp-claw/`) changes; no module needs
to know or care. This is the concrete, repo-level enforcement of §B's adapter-layer diagram.

## Next

Phase 3 (Backend) starts from `apps/backend/` above — first the `esp-claw/` adapter module itself
(pure, testable, no NestJS wiring yet), then `devices/` + `mqtt/` + `commands/` as the first
vertical slice (register a device, see it come online via `status`, send it one command, see the
response) — matching the MVP list in PHASE1-ANALYSIS.md §H/K, smallest slice first.

Tell me to proceed to Phase 3 once this structure looks right, or flag anything you'd rearrange
first.
