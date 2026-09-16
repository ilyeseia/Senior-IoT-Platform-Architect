# Architecture Evolution Audit — ESP-Claw IoT / Edge AI Platform

**Status: audit + design only. No code changed in this phase**, per your explicit instruction
(§30 of the brief). Every ESP-Claw claim below is sourced from a fresh, ground-truth read of
`C:\Users\seia\Desktop\esp-claw\esp-claw-2` (source + `docs/src/content/docs/en/`) done for this
audit — nothing is carried over from assumption. Every platform claim is sourced from the actual
files in this repo as they stand after Phase 5. Where the brief's generic architecture (NATS,
Keycloak, Kubernetes, eBPF, full Event Sourcing, microservices...) doesn't match current reality or
scale, this document says so explicitly and gives a KEEP/ADD NOW/ADD LATER/NOT NEEDED verdict
instead of adopting it by default — per the brief's own §28 and §29 principles.

---

## Part 1 — Current State Audit

### 1. Current Architecture

A modular monolith (`apps/backend`, NestJS), one deployable process. Modules today: `EspClawModule`
(protocol/topic adapter seam), `MqttModule` (single mqtt.js connection, presence + command
correlation), `DevicesModule` (registry, presence persisted from an MQTT event), `CommandsModule`
(dispatch + history), `DatabaseModule` (TypeORM/Postgres, migrations-only), `HealthModule`,
`ConfigModule` (Zod-validated env). No frontend yet (Phase 7 not started). No auth/identity/RBAC.
No automation/rules engine. No OTA/firmware module. No observability stack. No Digital Twin —
`Device` is reported-state-only (`online`, `lastSeenAt`), no `desired` concept exists.

### 2. Current Technology Stack

pnpm workspaces monorepo; NestJS + TypeScript; `mqtt.js` against an **external** CloudAMQP broker
(no self-hosted broker — confirmed decision, `PHASE1-ANALYSIS.md` §K.1); TypeORM →
PostgreSQL 16 + TimescaleDB extension (extension enabled, **unused** — no hypertable exists because
no telemetry table exists yet); Zod for env + wire-protocol validation; `EventEmitter2` for
in-process decoupling; vitest + `aedes` (in-process broker) for MQTT integration tests; Docker
Compose with one service (`postgres`) today.

### 3. Current Data Flow

**Inbound:** Device → CloudAMQP (MQTT 3.1.1, esp-mqtt) → the one `MqttService` connection (`#`
wildcard subscribe, own tenant-safe topic parser) → in-memory presence map + `EventEmitter2`
`device.status` event → `DevicesService` upserts a Postgres row.
**Outbound:** HTTP caller → `CommandsService.dispatch()` → persists a `pending` `Command` row →
`MqttService.sendCommand()` (publish, correlate reply by wire `id` via an in-memory pending-map,
timeout) → classify the response (`succeeded`/`rejected`/`timed_out`/`failed`, using the real
`"Denied agent cap call"` string the firmware returns) → persist `CommandResult`, update
`Command.status`. Everything is single-process; there is no external event bus yet.

### 4. Current ESP-Claw Integration

Only 3 of ESP-Claw's real surfaces are touched: the `status`/`command`/`response` MQTT leaves,
generically forwarding any capability name+input. Nothing yet built for: the local `/api/config`
HTTP endpoint over the tailnet (planned per decision #3, not implemented), the real MCP
server/client, Lua rules, on-device memory, skills, OTA orchestration, or capability introspection
(`/api/capabilities`). `CommandsService.dispatch()` will happily "dispatch" a misspelled capability
name — there is no catalog of what a given device's firmware actually exposes, and no validation of
`input` against that capability's real `input_schema_json`.

### 5. Current MQTT Architecture

One shared connection, `#` subscribe + custom topic parser (correctly handles multi-segment
tenant-scoped `base_topic`, unlike a fixed-depth wildcard). Exactly 3 leaves exist on real
firmware: `status` (retained LWT boolean), `command` (`{id,action:"capability",name,input}`),
`response` (`{id,capability,ok,result}`). Correlation is an in-memory `Map` — correct for one
backend instance, explicitly deferred to Redis only once horizontal scaling needs it. **Unresolved
risk, carried over from Phase 4**: whether the user's CloudAMQP plan actually delivers retained
`status` messages immediately on subscribe was never confirmed against real credentials.

### 6. Current API

REST only, no versioning, no pagination, no auth: `GET/POST /mqtt/status|presence|devices/:id/commands`
(Phase 4 debug surface — still live), `GET /devices`, `GET /devices/:id`,
`GET/POST /devices/:id/commands` (Phase 5, the real surface), `GET /esp-claw/*`, `GET /health`. No
WebSocket. No generated OpenAPI spec. No rate limiting. No consistent error envelope across
controllers.

### 7. Current Database

Postgres 16 + TimescaleDB extension (enabled, dormant). Three tables: `devices` (id = MAC-derived
device_id PK, `baseTopic`, `online`, `lastSeenAt`, `firstSeenAt`, `updatedAt` — reported-state only;
no `capabilities`/`firmwareVersion`/`hardware`/`desiredState` columns exist), `commands` (id = uuid
= the wire-protocol `id`, device FK, `name`, `input` jsonb, `status` enum, `timeoutMs`, `createdAt`,
`resolvedAt`), `command_results` (`commandId` PK/FK, `ok`, `result` text, `receivedAt`). No
users/organizations/RBAC tables anywhere. No object storage. No Redis.

### 8. Current Authentication

**None.** Zero auth on any HTTP route. Zero app-owned auth on the MQTT connection (whatever
CloudAMQP enforces at the broker level is external to this codebase). No OIDC/JWT/API-key/mTLS
exists in the backend today. This is the largest real gap versus "production-grade platform," ahead
of anything else in this document.

### 9. Current Deployment

Docker Compose, one service (`postgres`, `timescale/timescaledb:latest-pg16`, non-secret dev
credentials committed to `.env.example` on purpose — reproducible, not sensitive). The backend
itself runs outside Docker today (`pnpm start`/`start:dev`); backend/frontend/nginx compose services
are deliberately not created yet, matching the "append per phase, don't build ahead" discipline
already established in Phases 3-5.

### 10. Current Problems

- **(a) No auth at all** — anyone who can reach the HTTP port can command any device.
- **(b) No capability catalog/schema validation** in `CommandsService.dispatch()` — a misspelled
  capability name silently times out 15s later instead of failing fast with a clear error.
- **(c) No Digital Twin** — `devices` tracks online/offline only, not desired-vs-reported
  config/state.
- **(d) In-memory correlation + presence** means a backend restart drops in-flight commands and
  needs a fresh retained-status delivery to rebuild presence — fine at current scale, a real
  limit past one instance.
- **(e) No audit trail** beyond the `commands` table itself — no immutable log of "who changed
  what, when" for config/OTA/security-relevant actions.
- **(f) Dead/overlapping surface** — Phase 4's `/mqtt/*` debug endpoints and Phase 5's
  `/devices/:id/commands` now both exist and do almost the same thing; the debug ones were never
  retired.
- **(g) Unconfirmed deployment assumption** — the ambiguous "-ب" answer about network deployment
  (`PHASE1-ANALYSIS.md` §K.2) was answered on my own stated assumption (Tailscale tailnet) and has
  never been explicitly re-confirmed by you.

---

## Part 2 — Target Architecture

### 11. Target Architecture

**Keep the modular monolith.** Do not fragment into services yet: the confirmed real scale is
"tens of devices over 1-2 months" (`PHASE1-ANALYSIS.md` §K.5) — a distributed system at that scale
adds pure operational cost for zero benefit, and directly contradicts the brief's own §23/§28.
Reorganize the monolith's *module* boundaries around the five planes as a naming/dependency-
direction convention, not as new deployables. The mapping is already surprisingly close to
reality: `DevicesModule`/`CommandsModule`/`DatabaseModule` → Control + Data Plane; a new
`AgentModule`/`McpGatewayModule` → Agent Plane; nothing yet → Edge Plane; nothing yet →
Observability Plane. Keep `EventEmitter2` as the internal seam (§20) that later becomes the
event-bus boundary if extraction is ever justified.

### 12. Control Plane

- **`DeviceRegistryModule`** (upgrade of `DevicesModule`) — add `capabilities`/`firmwareVersion`/
  `hardware`/`networkInfo`/`securityState` columns, sourced from the device's real
  `/api/capabilities` and `/api/config?meta=1` endpoints reached over the tailnet (decision #3),
  never hand-maintained.
- **`IdentityModule`** — users/organizations/RBAC. Does not exist today; needed before any
  multi-user access, and it's the fix for Problem (a).
- **`ProvisioningModule`** — device onboarding/claiming flow.
- **`FirmwareModule` + `OtaModule`** — MinIO-backed artifact storage + orchestration that calls the
  real `ota_update` capability (see §23).
- **`PolicyModule`** — decides which platform role may call which capability. Its source of truth
  should be the firmware's own `RESTRICTED`/`ROOT_AGENT_ONLY` flag set (confirmed real, see the
  audit's §8 finding) — not a second, independently-maintained classification that can drift from
  what the device actually enforces.

### 13. Data Plane

`CommandsModule` stays as-is (already correctly separated). A new `TelemetryModule` has an honest
constraint to design around: ESP-Claw's `status` MQTT leaf carries only `{online: bool}` today —
there is **no telemetry-push leaf**. Two real options, no invented third:

1. **Poll** existing read-only capabilities (e.g. `get_system_info`) on a schedule over the
   existing `command`/`response` leaves. Works today, zero firmware changes, pull-based, adds MQTT
   traffic proportional to poll frequency × fleet size.
2. **Extend the firmware** to publish a new retained/QoS0 `telemetry` leaf. Real capability, but a
   firmware-side change outside this platform audit's scope — flag it to the ESP-Claw side, don't
   assume it.

Recommend (1) now; revisit (2) only once concrete sensor/metrics requirements exist.
`StateModule` = the Digital Twin (§18). `AlertModule` is correctly **not built yet** — there's
nothing to threshold against until `TelemetryModule` exists.

### 14. Agent Plane

A new `AgentModule` modeling what ESP-Claw's own docs describe — not an invented abstraction: one
Agent record per device (`device_id`, model/provider mirrored from the device's real `llm`/`llm2`
config fields, `enabled_cap_groups`/`llm_visible_cap_groups` mirrored from its NVS config). Memory
is **not duplicated on the platform** — `claw_memory` already lives on-device (FATFS-backed session
history + long-term facts, confirmed real); the platform only needs a way to *reach* it, not store
a second copy. The Agent Plane's actual integration surface is the MCP Gateway (§19), since Lua,
memory, and skills are only reachable from outside the device through surfaces that already exist
(MCP server, command/response, config HTTP) — there is no 4th protocol to invent.

### 15. Edge Plane

Genuinely **not needed yet**, and the brief agrees (§12: "must work without a gateway for simple
deployments"; §23: "don't optimize for 100k at the expense of 10"). At "tens of devices, one
Tailscale tailnet" scale, every device is already directly reachable — a gateway hop solves an
offline-operation requirement nobody has stated. Reserve the module name (`EdgeGatewayModule`) so a
future real requirement doesn't force a rewrite, but build nothing now.

### 16. Observability Plane

**Add now, minimally**: structured logging + `correlation_id` propagation, reusing the
wire-protocol `id` the platform already generates per command as that correlation id end-to-end
(don't invent a second id). This is nearly free and directly answers Problem (e)'s missing audit
trail. **Add later**: Prometheus + Grafana, once there's more than one deployment worth comparing
and someone is actually watching a dashboard day-to-day. **Not needed** at this scale:
OpenTelemetry/Tempo/Loki/eBPF — full distributed-tracing infrastructure for a single-process
monolith serving tens of devices solves a problem that doesn't exist yet, which is exactly what
§28 warns against.

### 17. Device Registry

Upgrade path for the existing `devices` table (§7), populated only from data the device actually
exposes: keep `id`/`baseTopic`/`online`/`lastSeenAt`; add `firmwareVersion`/`hardware` (from
`/api/config?meta=1`, over the tailnet per decision #3); add `capabilities` jsonb (from the real
`GET /api/capabilities` HTTP endpoint the audit confirmed exists — pull it, don't hand-list it);
add `securityState` (e.g. a `secretsNotMaskedOnConfig: true` flag per firmware version, since the
audit confirmed `GET /api/config` still doesn't mask secrets — the registry should track this
per-device rather than the platform silently assuming every device has the fix).

### 18. Digital Twin

Add `desiredState`/`reportedState` jsonb to `devices` (or a 1:1 `device_shadows` table). Honest
constraint: `reportedState` can only be populated from what ESP-Claw actually reports —
`GET /api/config` (full live config, over the tailnet) or specific read-only capability responses
(`ota_status`, `vpn_status`, etc. — real, unrestricted, confirmed by the audit) — **not** from a
generic telemetry push that doesn't exist (§13). `desiredState` maps directly onto a
`POST /api/config` body (decision #3) or a specific restricted capability call (`vpn_configure`,
`mqtt_configure`, `wireguard_configure` — all real, all root-agent-only per the audit). Drift
detection (`desired != reported`) is a scheduled job diffing the twin against a fresh
`GET /api/config` — implementable today, zero firmware changes required.

### 19. MCP Gateway

Justified by a real capability, not invented: the audit confirms `cap_mcp_server` runs a genuine
MCP server over HTTP+SSE with mDNS discovery, and `cap_mcp_client` lets a device call OUT to other
MCP servers — including other ESP-Claw devices (a real device-to-device agent mesh, per the
firmware's own docs). The Gateway's actual job: reach each device's MCP server over the tailnet
(the *same* reachability model as decision #3 — no new network path to design), present one
aggregated MCP endpoint to a Central Agent, and translate "call tool X on device Y" into an
HTTP+SSE MCP request to device Y's tailnet address. **Do not hardcode a tool list** — capabilities
are dynamic and self-describing (`/api/capabilities`, `input_schema_json`, confirmed by the audit);
the Gateway must discover, not enumerate.

### 20. Event Architecture

Keep `EventEmitter2` for now — it already gives in-process pub/sub with zero new infrastructure,
and the whole platform is one process. Adopt the brief's event envelope shape (`event_id`,
`event_type`, `timestamp`, `device_id`, `organization_id`, `correlation_id`, `payload`) **now** as
the internal TypeScript event-interface shape, even while the transport stays in-process — that's
the concrete seam that lets NATS JetStream slot in later (§21) by swapping only the transport
adapter, not every producer/consumer. Do not stand up NATS today — there is no second process to
justify a broker between, and the brief itself says "when justified," which isn't yet.

### 21. Microservices Evolution Strategy

Applying the brief's own path honestly to current reality: **step 1 is already true** (modular
monolith). **Step 2** (event-driven modules) = adopting the typed event envelope internally (§20)
— cheap, recommend doing it now. **Step 3** (extract high-load modules) has no real candidate yet
— nothing in this platform is under measurable load; extracting against imagined future load
instead of measured load is the over-engineering §5/§28 explicitly warn against. For the record: if
load ever justifies it, `MqttModule`/`CommandsModule` (the device-I/O path, with its one external
latency-sensitive dependency) would extract first — but that's a documented future option, not a
current task. Per-service data-ownership/API/event answers (the brief's required table in §5) stay
deferred until a service is actually proposed — answering them for a hypothetical service today
would mean inventing requirements nobody has yet.

### 22. Security Architecture

The single biggest real gap (Problem a/8) — **add now**: an `IdentityModule` (plain JWT is enough;
Keycloak/OIDC is unjustified infrastructure at this scale, see decision table) for platform users,
plus a placeholder API-key/mTLS decision for service-to-service calls (none exist yet, so this is
future-only). Device-side trust already has a real model to mirror, not invent: the firmware's own
`RESTRICTED`/`ROOT_AGENT_ONLY` capability flags (confirmed by the audit) should be `PolicyModule`'s
source of truth for "which platform role may call which capability" — an independent
classification risks silently drifting from what the device actually enforces. Two concrete,
already-known device-side risks the platform must design *around*, not solve on the device's
behalf: secrets are not masked on `GET /api/config` (audit §10) — the platform's own vault must
stay push-only (already decided, `PHASE1-ANALYSIS.md` §K.4) and must redact any device-forwarded
config blob before it ever reaches a UI; and OTA has no image signing (audit §12) — `FirmwareModule`
should at minimum hash and pin artifacts it stores, and refuse to push one whose hash doesn't match
what was uploaded, since the device itself won't catch corruption/tampering beyond TLS transport
trust.

### 23. OTA Architecture

Must match the **real** device flow (audit §12), not the brief's generic checklist verbatim. Real
flow today: `ota_update(url)` capability, `https://`-only enforced on-device, `esp_https_ota()`
with cert-bundle validation, reboot on success — **no image signing, no confirmed
rollback-on-failed-boot wiring**. Platform's honest job: Upload → store in MinIO (decision table:
ADD NOW) → compute + store SHA-256 (mitigates the missing on-device signing, §22) →
compatibility check against `DeviceRegistry`'s real `hardware`/`firmwareVersion` fields (§17) →
deploy by calling the real `ota_update` capability with a tailnet- or HTTPS-reachable URL to the
stored artifact → progress by polling the real, unrestricted `ota_status` capability → health check
= post-reboot presence + a version-reporting capability call. **Rollback** cannot be orchestrated
beyond re-pushing the previous artifact — the audit found no automatic rollback-on-failed-boot on
the device, so this limitation belongs in the UI copy, not hidden behind a "rollback" button that
implies more safety than exists.

### 24. Edge Gateway Architecture

Not designed in detail now — see §15. Reserve the module boundary only: if built later, it sits
between `MqttModule` and the device fleet as an optional store-and-forward relay using the *same*
wire protocol (`topics.ts`/`envelope.ts`, already tenant-topic-aware), so neither devices nor
backend logic change — only a gateway process is inserted. No further design until a real
offline-operation requirement exists.

### 25. AI Agent Architecture

The brief's "Central AI Agent → Device Registry → Discover Device → Discover Capabilities → MCP →
ESP-Claw → Tool → Sensor/Actuator" flow maps directly onto pieces already confirmed real: Device
Registry (§17, real `/api/capabilities`) for discovery, MCP Gateway (§19, real `cap_mcp_server`)
for the call path, and the firmware's *own* authorization model
(`claw_cap_call`'s `RESTRICTED`/`ROOT_AGENT_ONLY`, confirmed by the audit) as the final enforcement
point. The platform's AI agent should never be granted a caller role above what a normal `AGENT`
gets on-device; root-only capabilities (`ota_update`, `*_configure`) should require an explicit,
human-approved `PolicyModule` rule — not be silently reachable "because it's the AI." Rate-limiting
and audit logging of AI-initiated calls reuse the same `commands` table + correlation-id logging
already designed in §16/§13 — no separate AI-specific audit mechanism is needed.

---

## Part 3 — Decision Table

| Technology / Concern | Decision | Why |
|---|---|---|
| Modular monolith (current) | **KEEP** | Matches real scale (§K.5); brief's own recommended starting point (§4). |
| PostgreSQL | **KEEP** | Already in use; correct home for Control+Data-Plane relational data (§14 of brief). |
| TimescaleDB extension | **KEEP** (dormant until §13 decision 2/telemetry table exists) | Already enabled; no cost to keep, no hypertable to create yet — nothing to convert. |
| CloudAMQP (external MQTT) | **KEEP** | Confirmed decision #1 — platform is an additional client, not a broker operator. |
| Self-hosted MQTT broker (EMQX etc.) | **NOT NEEDED** | Contradicts confirmed decision #1; no stated need to own the broker. |
| Redis | **ADD LATER** | Correctly deferred to Phase 8 / horizontal scaling; single-instance in-memory correlation is correct today. |
| NATS JetStream | **ADD LATER** | No second process exists yet to justify an internal broker; adopt the typed event envelope now (§20), the transport later. |
| MinIO / S3-compatible storage | **ADD NOW** | Needed the moment `OtaModule`/`FirmwareModule` exists (§23) — large binaries must not go in Postgres. |
| Keycloak (OIDC) | **ADD LATER** | `IdentityModule`+JWT solves the real, urgent gap (Problem a) cheaply; Keycloak is justified once multiple orgs/SSO are real requirements, not before. |
| HashiCorp Vault | **NOT NEEDED yet** | Current secret surface (MQTT_URL, DB creds) is small enough for env-based config; revisit if the vault-push design (§K.4) grows real device-fleet secret volume. |
| JWT auth for platform users | **ADD NOW** | Directly closes Problem (a), the single largest current gap. |
| Prometheus + Grafana | **ADD LATER** | Useful once there's more than one deployment and someone watches dashboards regularly; not yet. |
| OpenTelemetry / Tempo / Loki | **NOT NEEDED** | Full distributed tracing for a single-process monolith at this scale is solving a non-existent problem (§28). |
| eBPF observability | **NOT NEEDED** | Explicitly out of scope per the brief itself (§19: not for ESP32; and no Linux infra complex enough to justify it here). |
| K3s | **NOT NEEDED** | No deployment complexity (single Compose host) justifies it yet. |
| Kubernetes | **NOT NEEDED** | Same — premature per brief §24/§28 at "tens of devices." |
| Tailscale | **KEEP** (pending your re-confirmation of §K.2) | Already the assumed device- and platform-reachability model (decision #3's `/api/config` access, and §19's MCP Gateway path both depend on it). |
| WireGuard (standalone) | **NOT NEEDED for the platform** | Tailscale already provides the tunnel; ESP-Claw's own standalone WireGuard mode (firmware-side) is a device feature, not a platform dependency. |
| MCP (server+client) | **ADD NOW** (design, §19) | Real, confirmed firmware capability — the natural Agent Plane integration surface; implementing the Gateway is the first concrete Agent-Plane task. |
| WebSocket (dashboard real-time) | **ADD LATER** | Correctly deferred to Phase 8 in the original roadmap; no frontend exists yet to consume it (Phase 7 not started). |
| REST + OpenAPI | **ADD NOW (OpenAPI)** | REST already exists; generating an OpenAPI spec is low-cost and fixes part of Problem (f)'s inconsistent surface. |
| Full Event Sourcing | **NOT NEEDED** (partial only, per brief §22) | Append-only history for lifecycle/commands/OTA/security events is enough; there's no read-model complexity yet to justify full ES. |
| Digital Twin (`desiredState`/`reportedState`) | **ADD NOW** | Directly implementable today with zero firmware changes (§18); fixes Problem (c). |
| Device capability catalog (pull from `/api/capabilities`) | **ADD NOW** | Fixes Problem (b) cheaply; the endpoint already exists on-device. |
| Retiring the Phase-4 `/mqtt/*` debug endpoints | **REPLACE** (with the Phase-5 `/devices/:id/commands` surface) | Fixes Problem (f); keep one debug/raw endpoint at most, clearly labeled, not two overlapping "real" surfaces. |
| Edge Gateway | **NOT NEEDED now** (reserve module boundary) | No offline-operation requirement stated; premature per §15/§23/§28. |
| Go (as a second backend language) | **NOT NEEDED** | No component has a performance/concurrency profile that TypeScript/NestJS can't handle at this scale; introducing a second language now adds team/tooling cost with no measured benefit. |

---

## Open items requiring your decision before implementation starts

1. **§K.2 re-confirmation**: is the platform deployed on the *same* Tailscale tailnet as devices
   (my original assumption, load-bearing for §12/§18/§19/§23 all reaching devices via tailnet), or
   something else?
2. **Priority order** for Part 2's "ADD NOW" items — I'd suggest `IdentityModule`+JWT (Problem a,
   the biggest gap) → Device capability catalog + Digital Twin (§17/§18, cheap and unblocks OTA/AI
   sections) → MCP Gateway skeleton (§19) → OTA/Firmware (§23) — but this is your call to make,
   not mine.
3. Whether to keep or retire the Phase-4 `/mqtt/*` debug endpoints now, or after the new surfaces
   are proven (Problem f).

No code has been written for this phase. Tell me which of the "ADD NOW" items to start with and
I'll follow the same ANALYZE → DESIGN → IMPLEMENT → TEST → VERIFY → DOCUMENT discipline used for
Phases 1-5.
