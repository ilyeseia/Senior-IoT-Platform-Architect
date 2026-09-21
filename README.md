# ESP-Claw IoT Management Platform

Central IoT Management + MQTT + Telemetry + Automation + OTA + AI Agent Management platform
for fleets of heterogeneous ESP32 / ESP32-S3 / ESP32-C3 / ESP32-C6 / ESP32-H2 devices running
[ESP-Claw](https://github.com/espressif/esp-claw) firmware.

**Status:** Phases 1–6 done, plus telemetry (Data Plane, Option B), JWT identity, a first Digital
Twin, and the Stage 0 stabilization pass ([STAGE0-STABILIZATION.md](docs/architecture/STAGE0-STABILIZATION.md)).
The current direction is set by [ADVANCED-ARCHITECTURE-AUDIT.md](docs/architecture/ADVANCED-ARCHITECTURE-AUDIT.md)
(five planes, modular monolith, staged migration); `ARCHITECTURE-EVOLUTION.md` is the earlier audit.
Firmware-side findings and fixes: [FIRMWARE-HARDENING.md](docs/architecture/FIRMWARE-HARDENING.md).

| Phase | Scope | State |
| ----- | ----- | ----- |
| 1–3 | Analysis, repository structure, backend skeleton + `@esp-claw/protocol` | done |
| 4 | MQTT integration (client, presence, command/response) | done |
| 5 | Database (Postgres + TimescaleDB, migrations) | done, live-verified |
| 6 | ESP-Claw integration (capability catalog, local API client) | done |
| — | Telemetry (poll existing capabilities → hypertable) | done |
| — | Identity (JWT, first-admin bootstrap), Digital Twin v1 | done |
| Stage 0 | Stabilization (audit B1, B3, B4, B7, B8, B12, B13) | done |
| Stage 1+ | Module boundaries, event bus, RBAC, twin reconciliation, OTA, agents (audit §29) | proposed |

## Development

```bash
pnpm install
pnpm build          # builds @esp-claw/protocol first, then the backend (topological)
pnpm test           # backend MQTT integration tests (embedded aedes broker, no real creds)

# Real Postgres round-trip:
docker compose up -d postgres            # timescale/timescaledb:latest-pg16
cp .env.example apps/backend/.env        # then set DATABASE_URL and JWT_SECRET (required, min 16 chars)
pnpm --filter @esp-claw/backend start    # migrationsRun:true creates the schema on boot
curl localhost:3000/health                # public; everything else needs a JWT from POST /auth/login
```

See [docs/architecture/PHASE1-ANALYSIS.md](docs/architecture/PHASE1-ANALYSIS.md) for the full
design (ground-truth ESP-Claw review, architecture, MQTT protocol, database schema, device
lifecycle, technology-stack decisions, security model, MVP scope, roadmap) and the per-phase
notes in [docs/architecture/](docs/architecture/).
