# ESP-Claw IoT Management Platform

Central IoT Management + MQTT + Telemetry + Automation + OTA + AI Agent Management platform
for fleets of heterogeneous ESP32 / ESP32-S3 / ESP32-C3 / ESP32-C6 / ESP32-H2 devices running
[ESP-Claw](https://github.com/espressif/esp-claw) firmware.

**Status:** Phases 1–5 complete. Backend (NestJS) + shared `@esp-claw/protocol` package;
MQTT client with presence and command/response; Postgres + TimescaleDB with TypeORM migrations.
Phase 5 verified end-to-end against a real Postgres instance (app boots, migrations create the
`devices` / `commands` / `command_results` tables, `GET /health` and `GET /devices` respond).
Next: Phase 6 — ESP-Claw integration (capability catalog + local `/api/config` client over the tailnet).

| Phase | Scope | State |
| ----- | ----- | ----- |
| 1 | Architecture analysis (grounded in real ESP-Claw firmware) | ✅ |
| 2 | Repository structure | ✅ |
| 3 | Backend skeleton + `@esp-claw/protocol` | ✅ |
| 4 | MQTT integration (client, presence, command/response) | ✅ |
| 5 | Database (Postgres + TimescaleDB, migrations) | ✅ |
| 6 | ESP-Claw integration | ▶️ next |

## Development

```bash
pnpm install
pnpm build          # builds @esp-claw/protocol first, then the backend (topological)
pnpm test           # backend MQTT integration tests (embedded aedes broker, no real creds)

# Real Postgres round-trip:
docker compose up -d postgres            # timescale/timescaledb:latest-pg16
cp .env.example apps/backend/.env        # then set DATABASE_URL to your Postgres
pnpm --filter @esp-claw/backend start    # migrationsRun:true creates the schema on boot
curl localhost:3000/health
```

See [docs/architecture/PHASE1-ANALYSIS.md](docs/architecture/PHASE1-ANALYSIS.md) for the full
design (ground-truth ESP-Claw review, architecture, MQTT protocol, database schema, device
lifecycle, technology-stack decisions, security model, MVP scope, roadmap) and the per-phase
notes in [docs/architecture/](docs/architecture/).
