# Architecture Evolution — Advanced Audit (Control/Data/Agent/Edge/Observability Planes)

**This is an audit and proposal only. No code changed in this pass.** Per the brief's own rule
(§30, and rule #38 from the original prompt): every claim about ESP-Claw below was checked against
the real `esp-claw-2` firmware source in this session, not assumed. Every claim about *this*
platform's own code was checked by reading it, not recalled from memory. Where something doesn't
exist yet — on either side — it's labeled as a gap or new work, never presented as already built.

---

## PART A — CURRENT STATE (as of commit `096459f`, Phase 6 done)

### 1. Current Architecture

A **modular monolith already**, even though nobody set out to formalize it as one — NestJS's
module system happens to enforce the boundary discipline this evolution asks for. Six modules
today: `mqtt`, `devices`, `commands`, `esp-claw`, `database`, `health`, `config`. Cross-module
coupling is already disciplined in one important way worth preserving: `MqttService` does **not**
import `DevicesService` — it emits a `device.status` domain event via `EventEmitter2`, and
`DevicesService` subscribes with `@OnEvent`. That's a real, working, in-process event bus — small
in scope today (one event type), but the right shape to grow, not replace (see §20).

What does **not** exist yet, plainly: no frontend, no WebSocket, no auth enforcement, no
telemetry ingestion, no multi-tenancy, no observability, no event bus beyond in-process
`EventEmitter2`, no Redis/NATS/MinIO, no OTA control-plane bookkeeping, no digital twin, no MCP
gateway, no device groups, no alerts, no automation engine.

### 2. Current Technology Stack

| Layer | Choice | State |
|---|---|---|
| Backend framework | NestJS 10 + TypeScript | in use |
| Device protocol client | `mqtt` (mqtt.js) | in use, connects to a real CloudAMQP broker |
| ORM / migrations | TypeORM, `synchronize:false`, explicit migrations | in use |
| Primary DB | PostgreSQL 16 (via `timescale/timescaledb:latest-pg16` image) | in use |
| Time-series | TimescaleDB extension | **installed (`CREATE EXTENSION`), zero hypertables** — no telemetry table exists to convert yet |
| Validation | Zod (`@esp-claw/protocol` schemas, env validation) | in use |
| In-process events | `@nestjs/event-emitter` (`EventEmitter2`) | in use, one event type (`device.status`) |
| Testing | Vitest, plus an embedded `aedes` broker for MQTT integration tests | in use, 33 tests green |
| Monorepo | pnpm workspaces (`apps/*`, `packages/*`) | in use |
| Deployment (dev) | Docker Compose, **Postgres only** | in use |
| Cache/queue | Redis | not introduced |
| Event bus | NATS/JetStream or any broker | not introduced |
| Object storage | MinIO/S3 | not introduced |
| Observability | OpenTelemetry/Prometheus/Grafana/Loki/Tempo | not introduced |
| Auth | JWT/OIDC | not introduced (`JWT_SECRET` is an unused optional env var) |
| Frontend | React/Next/Vue | not started (Phase 7, next) |

### 3. Current Data Flow

Two real, verified round-trips exist today:

```
Presence:
  ESP-Claw (birth/LWT on "status", retained, QoS1)
    → MqttService (subscribes "#", parses via @esp-claw/protocol)
    → emits "device.status" (EventEmitter2)
    → DevicesService.handleDeviceStatus() → upsert devices row (online, lastSeenAt)

Command/Response:
  POST /devices/:id/commands {name, input?}
    → CommandsService.dispatch(): INSERT commands row (status=pending)
    → MqttService.sendCommand(): publish {id, action:"capability", name, input} to .../command (QoS1)
      → in-memory Map<id, {resolve,reject,timer}> tracks the pending call (single-instance only)
    → device's real cap_mqtt bridge executes the capability, publishes {id, ok, result} to .../response
    → MqttService resolves the pending promise by id
    → CommandsService classifies: ok:true → succeeded; ok:false + "Denied agent cap call" → rejected;
      "timed out" → timed_out; else → failed. INSERT command_results row.
    → HTTP response carries the real device result back to the caller

Capability discovery (Phase 6, one-shot, not a live path):
  POST /devices/:id/capabilities/refresh {baseUrl}
    → LocalApiClient.fetchCapabilities() — plain HTTP GET over the tailnet, allow-listed to
      /api/capabilities and /api/status only (never /api/config)
    → upsert device_capabilities rows, update devices.localApiBaseUrl/capabilitiesRefreshedAt
```

**There is no telemetry flow at all.** No topic is subscribed for sensor/metric data (none exists
on real firmware today either — see §5), no hypertable exists to store it, no ingestion module
exists. This is the single largest gap between "current data flow" and the Data Plane vision in
§13.

### 4. Current ESP-Claw Integration — what's real, re-verified this session

This platform's entire ESP-Claw integration rests on primitives that are genuinely real (I
built/shipped this exact firmware subsystem earlier this session, on real ESP32-S3 hardware) —
not invented for the platform side:

- **`claw_cap` capability model** (`claw_cap_descriptor_t`): every device tool has `id`, `family`,
  `description`, `kind` (`CALLABLE` / `EVENT_SOURCE` / `HYBRID`), `cap_flags`
  (`CALLABLE_BY_LLM` / `RESTRICTED` / `ROOT_AGENT_ONLY` / …), and a JSON-Schema. Grouped
  (`cap_mqtt`, `cap_vpn`, `cap_ota`, `cap_system`, `cap_mcp_client`, `cap_mcp_server`,
  `cap_agent_mgr`, `cap_web_search`, …).
- **HTTP introspection surface is narrow, and I re-confirmed the *entire* route inventory this
  pass**: `/api/status`, `/api/capabilities` (groups only — no per-tool descriptors, confirmed by
  reading `http_server_capabilities_api.c` again), `/api/config` (**secrets in plaintext**),
  `/api/files`, `/api/lua/*`, `/api/lua-modules`, `/api/restart`, `/api/webim/*`,
  `/api/wechat/*`. Nothing else. No telemetry endpoint, no MCP-tool-listing endpoint, no
  per-tool-schema endpoint exists over HTTP today.
- **The MQTT command bridge only reaches `CALLABLE_BY_LLM` capabilities that are *not*
  `RESTRICTED`/`ROOT_AGENT_ONLY`** — after the auth-bypass fix I made earlier this session, that
  restriction is now correctly enforced. Concretely, **today, over raw MQTT, the platform cannot
  deterministically trigger**: `mqtt_configure`, `vpn_configure`, `wireguard_configure`,
  `ota_update`, or — newly confirmed this pass — **any of `cap_agent_mgr`'s tools**
  (`spawn_agent`, `send_agent_followup`, `inspect_agent`, `list_agents`, `close_agent`,
  `delete_agent` — all `CALLABLE_BY_LLM | ROOT_AGENT_ONLY`). This is a load-bearing constraint on
  §18 (Digital Twin sync), §23 (OTA), and §25 (Agent Plane fleet orchestration) — repeated there,
  not just here, because it's easy to design around it by accident.
- **MCP** (newly re-verified this pass, not covered in Phase 1): a device is *both* an MCP client
  (`cap_mcp_client`: `mcp_list_tools`, `mcp_call_tool` against a remote MCP server over HTTP;
  `mcp_discover` via LAN mDNS) *and* an MCP server (`cap_mcp_server`: exposes the device's own
  tools over HTTP + mDNS on the LAN). Both directions are `CALLABLE_BY_LLM`-flagged capability
  calls reachable via the *existing* command/response envelope — **zero new firmware needed** to
  trigger `mcp_call_tool` from the platform today. What's genuinely missing: any way for the
  platform (which is not on the device's LAN) to *discover or reach* a device's own MCP server —
  mDNS doesn't route across the tailnet the way it's being described in the brief's §10 diagram.
  See §19.
- **`cap_agent_mgr`** (newly re-verified this pass): ESP-Claw already has on-device *sub-agent*
  orchestration — spawn/inspect/list/close/delete — root-agent-only. This directly informs §25:
  the platform's job is fleet-level visibility and triggering, not reimplementing agent lifecycle
  logic that already exists per-device.
- **`claw_memory`** (newly re-verified this pass): per-device, on-device LLM-callable memory
  store (`recall`/`store`/`forget`), reachable the same way as any other capability if
  LLM-visible. This is the agent's own knowledge store — **not** a config-sync primitive; do not
  conflate it with Digital Twin `reported_state` in §18.
- **`claw_event_router`** (newly re-verified this pass): a real, already-shipped **on-device**
  local/offline automation engine — rules with actions `CALL_CAP` / `RUN_AGENT` / `RUN_SCRIPT` /
  `SEND_MESSAGE` / `EMIT_EVENT`, and cap kind `EVENT_SOURCE` for capabilities that publish events
  into it. This matters enormously for §14 (Edge Plane) and §24 (offline-first): **each ESP-Claw
  device is already its own working edge-automation node**; there is no need to invent an
  offline-automation mechanism, only to decide how the platform's Automation module (§21)
  interacts with it (push rules down, or leave device-local rules as a separate authoring
  surface — recommend the latter for MVP, see §21).
- **Skills** (`.agents/spec/claw-skill-spec.md`, `claw_skill` module): exist on-device as
  user-facing skill documents/activation state. Not touched by the platform at all yet — no
  gap analysis changes here from Phase 1.

### 5. Current MQTT Architecture

Topic scheme, verified again this pass against `packages/esp-claw-protocol/src/topics.ts` and the
firmware: `{base_topic}/{device_id}/{leaf}`, only **three leaves exist on real hardware**:
`status`, `command`, `response`. `base_topic` is free text (`mqtt_base_topic`, default `espclaw`)
and may itself contain `/`, which is how tenant scoping works today with zero firmware changes
(e.g. `espclaw/acme-farms`).

- QoS: status birth/LWT is QoS1 retained; commands are published QoS1; response QoS is
  device-controlled (not asserted by the platform).
- Correlation: **application-level `id` field inside the JSON payload**, not MQTT5 Correlation
  Data — I re-checked `mqtt.service.ts` this pass and confirmed the client connects with mqtt.js
  defaults (**MQTT 3.1.1**, no `protocolVersion: 5`, no MQTT5 properties used anywhere). The
  original brief's "use MQTT5 where suitable" is **not yet acted on** — correctly so: there's no
  concrete MQTT5-only feature (topic aliases, shared subscriptions, richer session control) that
  today's scale needs, and CloudAMQP's MQTT5 support level hasn't been verified. Flagged as an
  open question in §Questions, not silently decided either way.
- No `telemetry`/`events`/`logs`/`ota` leaves exist on real firmware — the original prompt assumed
  a wider topic namespace than what's real; Phase 1 already corrected this, re-confirmed here.

### 6. Current API

REST only, all unauthenticated: `GET/POST /devices`, `GET /devices/:id`,
`GET/POST /devices/:id/commands`, `GET /devices/:id/capabilities`,
`POST /devices/:id/capabilities/refresh`, `GET /health`, plus two debug-only surfaces kept
deliberately separate from the real DB-backed API (`GET /esp-claw/topics`, `GET/POST /mqtt/*`
in-memory). No WebSocket, no OpenAPI/Swagger, no pagination/filtering/sorting, no rate limiting,
no versioning, no consistent error envelope beyond Nest's defaults.

### 7. Current Database

`devices` (id = real MAC-derived device_id, `deviceName`, `baseTopic`, `online`, `lastSeenAt`,
`firstSeenAt`, `updatedAt`, and — Phase 6 — `localApiBaseUrl`, `capabilitiesRefreshedAt`),
`device_capabilities` (composite PK `device_id+groupId`), `commands`, `command_results`,
`migrations`. **No `organizations`/`users`/`projects`/`audit_logs`/`firmware`/`ota_jobs`/`alerts`/
`automation_rules`/`api_keys` tables exist.** No `org_id` anywhere — this is deliberate (documented
in the `Device` entity's own comment: don't add placeholder FKs before Auth/multi-tenancy is
real), and still the right call — re-affirmed, not changed, in §22.

### 8. Current Authentication

**None, at any layer.** No JWT verification on any REST route (`JWT_SECRET` is read by env
validation but nothing consumes it yet). No device-level MQTT auth beyond the shared broker
credentials the operator already owns (CloudAMQP username/password) — every device currently
authenticates with the *same* broker-level credential, not per-device credentials or certificates;
I could not verify from this codebase alone whether CloudAMQP's plan in use supports per-client
credentials or mTLS, so that's listed as an open question (§Questions), not assumed either way.

### 9. Current Deployment

`docker-compose.yml` runs **only Postgres** today (by design — matches the "don't build ahead of
the phase that needs it" discipline that's been followed since Phase 3). Backend runs via
`pnpm --filter @esp-claw/backend start[:dev]` directly on the host, not containerized itself yet.
No Kubernetes/K3s anywhere.

### 10. Current Problems (blunt, ranked by how much they block the target architecture)

1. **No telemetry path exists at all** — the single biggest gap between today and the Data Plane
   vision. TimescaleDB is installed and unused.
2. **Zero authentication/authorization** — every REST endpoint is open; this must be closed before
   any non-localhost deployment, and it's also a prerequisite for §25 (AI-native management can't
   be policy-gated without it).
3. **`RESTRICTED`/`ROOT_AGENT_ONLY` capabilities are unreachable via the deterministic MQTT
   command path** — blocks automated OTA, automated bulk config push, and automated fleet-level
   sub-agent orchestration until the `cap_platform` firmware extension (Phase 1 §item-8) is built.
   This is a firmware-side prerequisite, not something the platform can architect around.
4. **In-memory-only command correlation** (`Map` in `MqttService`) — correct for one instance
   (already documented as a known Phase 8 Redis migration target), but means the backend cannot
   run more than one instance today without losing in-flight command tracking on a crash/restart.
5. **No multi-tenancy in the schema** — single-tenant is fine for now (explicitly the stated
   starting point), but there's currently *no* enforcement that ties a device to an org even at
   the "one org for now" level, so the migration to real multi-tenancy later will need a backfill,
   not just new tables.
6. **Capability/status introspection depends on a manually-provided tailnet URL per device** — no
   device self-registers its own reachable URL over MQTT yet, so `POST .../capabilities/refresh`
   doesn't scale past a handful of manually-managed devices.
7. **MCP is LAN-local by nature (mDNS)** — no cross-site discovery/aggregation exists; a "central"
   MCP Gateway spanning multiple physical sites is new work, not a wrapper around something that
   already reaches across sites.
8. **No event bus beyond in-process `EventEmitter2`** — fine today (one event type, one instance),
   but will not survive multiple backend instances or independent consumers (Alerts, Automation)
   without becoming lossy.
9. **No idempotency/dedup design exists yet at any ingest boundary** — not urgent (no telemetry
   ingest exists to need it yet), but must be designed into the *first* telemetry-ingest code, not
   retrofitted after.
10. **Zero observability** — no traces, metrics, or structured log aggregation; today's debugging
    is NestJS's console `Logger` only.

---

## PART B — TARGET ARCHITECTURE

### 11. Five Planes, Mapped to What's Real Today

```
┌─────────────────────────────────────────────────────────────────────┐
│ CONTROL PLANE          registry(✓partial) identity(✗) provisioning(✗)│
│                        firmware/OTA bookkeeping(✗) policies(✗)       │
│                        groups(✗)   — device-side OTA *execution*     │
│                        mechanism (cap_ota) already exists on-device  │
├─────────────────────────────────────────────────────────────────────┤
│ DATA PLANE             commands(✓) presence(✓) telemetry(✗ — biggest │
│                        gap) digital twin(✗) alerts(✗)                │
├─────────────────────────────────────────────────────────────────────┤
│ AGENT PLANE            maps directly onto real on-device primitives: │
│                        claw_cap(✓ real) cap_agent_mgr sub-agents     │
│                        (✓ real, root-only) claw_memory(✓ real)       │
│                        MCP client+server(✓ real, LAN-local) —        │
│                        platform-side fleet view(✗)                  │
├─────────────────────────────────────────────────────────────────────┤
│ EDGE PLANE             per-device local automation ALREADY SHIPPED   │
│                        (claw_event_router) — multi-device Edge       │
│                        Gateway (aggregation across a site) NOT built │
├─────────────────────────────────────────────────────────────────────┤
│ OBSERVABILITY PLANE    not started (✗ everywhere)                    │
└─────────────────────────────────────────────────────────────────────┘
```

The key insight worth stating plainly: **two of the five planes (Agent, Edge) already have real,
working on-device implementations.** The platform's job for those two planes is materially
different from the other three — it's *fleet-level visibility and orchestration triggers* over an
existing mechanism, not building the mechanism itself. Designing the Agent/Edge plane modules as
if they need to reimplement agent loops or rule engines would duplicate real ESP-Claw
functionality — exactly what the brief's rule #38 (and this evolution's own §2 "don't invent")
warns against.

### 12. Control Plane — modules and honest scope

| Module | Today | Proposed |
|---|---|---|
| Device Registry | `devices` + `device_capabilities` tables, REST CRUD (partial) | extend, don't rebuild: add `orgId` (nullable, backfillable), `hardwareModel`, `firmwareVersion`, `health` summary columns, sourced from `/api/status` + future capability-result introspection |
| Identity/Auth | none | new `Identity` module: local users table + JWT (Phase 10-scoped already); Keycloak/OIDC **not now** (§22) |
| Provisioning | manual (`baseTopic` assignment, manual `localApiBaseUrl`) | new `Provisioning` module: device self-announces its capability catalog + local URL on first `status` birth message (already partially true — `findOrCreate` auto-registers on first status; extend to also request a capabilities refresh on first contact, using the device's *reported* IP from `/api/status` fetched once reachability is confirmed some other way — needs a decision, see §Questions) |
| Firmware/OTA bookkeeping | none | new `Firmware`/`OTA` modules: binary storage (MinIO, §27), version tracking, target device-group rollout tracking, **execution still gated by the firmware-side `cap_platform` prerequisite** (§23) |
| Policies | none | new, small: per-org/per-device-group rule of "who can dispatch which capability family" — this is what makes §25's AI-agent authorization real, not just a REST guard |
| Device Groups | none | new `DeviceGroup` module: many-to-many `devices`↔`groups`, used by OTA rollout and bulk command dispatch |

### 13. Data Plane — the real gap, sequenced correctly

Telemetry does not exist on real firmware *or* the platform today. Two honest options, presented
without picking one prematurely (this needs a firmware-side decision, see §Questions):

- **Option A (new firmware capability):** ESP-Claw grows a `telemetry` MQTT leaf and a
  lightweight on-device sampling mechanism (which sensors, at what interval) — genuinely new
  firmware work, not assumed to exist.
- **Option B (agent-driven today, zero firmware changes):** the platform periodically dispatches
  existing `CALLABLE_BY_LLM` capabilities (e.g. `get_system_info`, `mqtt_status`, `vpn_status`) via
  the *existing* command/response path and stores the numeric/boolean fields from `result` as
  telemetry samples. This works **today**, with zero firmware changes, for anything already
  exposed as a capability result — at the cost of being pull-based (platform-initiated) rather
  than push-based, and limited to whatever capabilities already return.

Recommend **starting with Option B for MVP** (§17) precisely because it needs no firmware
changes and immediately unblocks the TimescaleDB hypertable + dashboard work, while flagging
Option A as the real fix once there's an actual sensor-telemetry need beyond system/network
metrics.

- **Digital Twin / device state** — see §18, its own section (this is new work either way).
- **Alerts** — new `Alerts` module, rule-evaluated against telemetry/state/presence
  (`device offline > N minutes`, `field crosses threshold`) — straightforward once telemetry (or
  at minimum presence, which already exists) is queryable.

### 14. Agent Plane — fleet view over a real on-device mechanism

New `Agent` module, backend-side, whose job is:

1. Mirror what `cap_agent_mgr`'s `list_agents`/`inspect_agent` report per device (once reachable —
   see the `ROOT_AGENT_ONLY` constraint below) into a queryable fleet-wide table.
2. Surface the capability catalog already pulled in Phase 6 (`device_capabilities`) as "what tools
   can this device's agent use" — this data already exists, no new pull mechanism needed.
3. Provide the trigger surface for deterministic, `CALLABLE_BY_LLM`-and-not-restricted capability
   calls (already works via `CommandsService` today) — and clearly gate anything touching
   `spawn_agent`/`close_agent`/`delete_agent`/etc. behind the same "not reachable over raw MQTT
   yet" constraint as OTA/config (§4, §23).

**Central Fleet Agent → per-domain agents** (Agriculture/Energy/Security/Camera, per the brief's
§11 example): this is a **platform-side orchestration pattern**, not an ESP-Claw concept — model
it as device-group-scoped "fleet agent" configuration (which model/provider/policy applies when
the platform's own AI features act on a group of devices), separate from and layered above the
per-device on-device agents that already run today.

### 15. Edge Plane — clarify what's already shipped vs. genuinely new

- **Already shipped, per device:** `claw_event_router` local rules (offline-capable,
  `CALL_CAP`/`RUN_AGENT`/`RUN_SCRIPT`/`SEND_MESSAGE`/`EMIT_EVENT`), LWT-based reconnect, and (from
  earlier phases of this same platform project) MQTT reconnect with exponential backoff. **A
  single ESP-Claw device does not need an Edge Gateway to keep working offline** — it already
  degrades gracefully on its own.
- **Genuinely new, if/when needed:** a multi-device **Edge Gateway** deployable (e.g. a small
  always-on box at a site) for: local telemetry aggregation before it reaches the cloud broker,
  bridging a *local* MQTT broker to the cloud one for sites with unreliable direct connectivity,
  or reaching devices' LAN-local MCP servers on behalf of the cloud platform (§19). **Not needed
  for MVP/V1** given the current fleet already connects directly to a cloud broker over
  Tailscale/WireGuard — add only when a concrete site has connectivity or bandwidth constraints
  that direct-to-cloud can't satisfy.

### 16. Observability Plane

Not started, and — per §21/§27 — correctly not started yet at this scale (one backend process, no
load). Concrete trigger to introduce it: once there's more than one backend instance, or once
telemetry ingest exists and needs its own health monitoring distinct from "is the whole app up."
Until then, NestJS's structured `Logger` output to stdout (captured by Docker in later phases) is
sufficient — deliberately not over-built ahead of need.

### 17. Device Registry — extend, don't rebuild

Already covered in §12's table. The concrete near-term addition (doesn't require the Data Plane
telemetry decision to land first): populate `hardwareModel`/`firmwareVersion` from `/api/status`
(already fetchable via `LocalApiClient`, just not yet mapped into `devices` columns) the next time
`refreshCapabilities` runs — small, additive, no schema surprises.

### 18. Digital Twin / Device Shadow

Genuinely new — nothing like it exists on either side today. Design:

```json
{
  "device_id": "ecda3b4ff7d4",
  "desired": { "sampling_interval": 30 },
  "reported": { "sampling_interval": 30 },
  "desiredVersion": 4,
  "reportedVersion": 4,
  "updatedAt": "..."
}
```

`reported` is populated from: (a) capability-call results dispatched today via `CommandsService`
(e.g. `get_system_info`), (b) future telemetry samples (§13), (c) `/api/status` pulls (§17).
`desired` is written by operators/automation. **Drift detection** (`desired != reported`) is a
straightforward per-field diff, surfaced as a device-level flag.

**The hard constraint, repeated because it's easy to forget while designing this in isolation:**
syncing a `desired` change for anything that maps to a `RESTRICTED`/`ROOT_AGENT_ONLY` capability
(`mqtt_configure`, `vpn_configure`, `wireguard_configure`) **cannot be automated today** — it can
only be *proposed* by the platform and requires the not-yet-built `cap_platform` signed-token path
(Phase 1 §item-8) to close the loop deterministically. For MVP, model this honestly: `desired`
changes for restricted fields sit in a `pending_manual` state until that firmware work exists, not
silently retried forever or fake-succeeded.

### 19. MCP Gateway

**Not an existing ESP-Claw API** — re-confirmed this pass. Two distinct capabilities, don't
conflate them:

1. **Outbound (works today, zero firmware changes):** platform dispatches a device's own
   `mcp_call_tool`/`mcp_list_tools` via the existing command/response envelope, exactly like any
   other capability call. This lets the platform ask a device to act as an MCP *client* against
   some third-party MCP server it can reach.
2. **Inbound aggregation (blocked on a scope decision, not just a design decision — see the
   firmware-work addendum's §B):** a later pass found `cap_mcp_server` is never actually started in
   `edge_agent` (only in the unrelated `mcp_server_point` example app) — so "devices' own MCP
   servers" don't exist on real deployed hardware today, and presenting *devices'* own MCP
   *servers* (LAN+mDNS-local, if they existed) as one aggregated endpoint for a central AI agent is
   not "genuinely new work to design," it's gated on first deciding whether `edge_agent` should run
   an MCP server at all. mDNS does not route across a tailnet the way a naive "central gateway"
   diagram implies, regardless. Two honest paths *if* that scope question is answered yes: (a)
   devices announce their MCP server's reachable URL over the existing `status` topic (small,
   additive firmware change — a new field, not a new leaf), and the platform proxies each one
   directly since they're already tailnet-reachable in this deployment; or (b) a per-site Edge
   Gateway (§15) that *is* on the same LAN reaches the mDNS services locally and re-exposes them
   upward. (a) would still be the smaller option once/if scoped in.

### 20. Event Architecture — envelope now, NATS later, with explicit trigger criteria

Define the standard envelope now (costs nothing, prevents rework later) and keep emitting it
through `EventEmitter2` until a concrete trigger fires:

```json
{
  "event_id": "uuid",
  "event_type": "device.status.changed",
  "timestamp": "...",
  "device_id": "...",
  "organization_id": null,
  "correlation_id": "...",
  "payload": {}
}
```

**Trigger to introduce NATS JetStream** (all-of, not any-of — this is deliberately conservative
per §27/§28): (1) telemetry ingest exists, **and** (2) a second module (Alerts or Automation) needs
to consume those events independently of the module that produced them, **or** (3) the backend
needs more than one instance for availability. None of these are true today. Introducing NATS now
would add a whole new piece of run-anywhere infrastructure to solve a horizontal-scaling problem
this deployment doesn't have yet — exactly the "over-engineered" failure mode §28 warns against.

Until the trigger fires: rename the current single `device.status` emit to the envelope shape
above (small, mechanical change, best done alongside whichever module first needs a second event
type — not urgent on its own).

### 21. Microservices Evolution Strategy

**Verdict for every listed service, right now: stay a module inside the monolith.** None of them
clear the bar the brief itself sets (Why / data ownership / independent load profile). The
concrete value today is in drawing the module boundaries *inside* the monolith so a future
extraction is a lift, not a rewrite:

| Proposed future service | Why it might eventually split | Why it stays a module now | Data it would own |
|---|---|---|---|
| Telemetry Service | high, bursty write volume, different scaling profile than control-plane CRUD | doesn't exist yet at all — build as a module first, learn its real load, then decide | hypertables |
| Device/Identity Service | stable, low write volume, security-sensitive | no reason to isolate a service with today's traffic | `devices`, `device_capabilities`, future `organizations`/`users` |
| Command Service | already isolated as a module; could scale independently once command volume is high | current volume is trivial; in-memory correlation (a real Phase 8 concern, §10.4) is the actual blocker, not module boundaries | `commands`, `command_results` |
| OTA/Firmware Service | large binary handling (MinIO), different resource profile (bandwidth) than API traffic | doesn't exist yet; build as a module against MinIO from day one so the *storage* boundary is already service-shaped even before the *process* boundary is | firmware binaries (MinIO), `ota_jobs` |
| Automation/Alert Service | rule evaluation could become CPU-heavy at fleet scale | trivial at current/near-term fleet size; premature | `automation_rules`, `alerts` |
| Agent Service | could front all AI-agent-facing traffic separately from operator-facing CRUD | no AI-agent consumer exists yet in this codebase (§25 is a design, not a built feature) | none yet |
| MCP Gateway | genuinely different protocol/transport concerns (§19) | still needs its inbound-aggregation design decided (§19) before it's even a module, let alone a service | none yet |
| Notification Service | fan-out to Telegram/email/push is naturally decoupled from everything else | low volume; a module with a clean interface is enough until fan-out volume says otherwise | none (stateless) |

Extraction path, when a service *does* clear the bar: **Modular Monolith → give that module its
own Postgres schema (not database) → put a real interface (HTTP or event) between it and the rest
→ extract the process.** Don't jump straight to "new service" without the schema-isolation step —
it's what makes the extraction safe to reverse if it turns out to be premature.

### 22. Security Architecture

Three identity domains, kept separate as asked:

- **Users:** local `users` table + JWT (already scoped for Phase 10 in the existing roadmap docs —
  no change to that plan). **Keycloak: not now.** Single-tenant, no SSO requirement exists today;
  Keycloak becomes justified once there's a real multi-tenant/SSO need (V2/Enterprise stage) — the
  brief's own instruction to "study but don't introduce unless justified" is followed literally
  here, not a placeholder for "add it anyway later this section."
- **Devices:** today, every device shares one broker-level credential (CloudAMQP username/
  password) — the real gap flagged in §10.8. Whether per-device MQTT credentials or client
  certificates are available depends on the CloudAMQP plan in use, which I cannot verify from this
  codebase — **open question, see §Questions**, not assumed either way. mTLS between platform and
  devices is not realistic given the device-local HTTP surface is deliberately LAN-only,
  unauthenticated, and not meant to be internet-facing (§4) — mTLS effort belongs on the
  MQTT/broker side, not the local HTTP side.
- **Services:** doesn't matter yet — one process. Matters once §21's extraction actually happens;
  design it then, against real service boundaries, not speculatively now.
- **Vault: not now**, same reasoning as Keycloak — today's secret surface is one broker URL + one
  future JWT secret, both fine as environment variables at this scale (already the pattern:
  `.env`, never committed, `.env.example` documents shape only). Revisit once per-device
  credentials (mTLS certs, or per-device broker creds) need issuance/rotation at fleet scale.

### 23. OTA Architecture — sequencing the firmware prerequisite correctly

Two halves that must not be conflated:

1. **Firmware-side execution mechanism — already real:** `cap_ota` (`ota_status`, `ota_update`),
   `ROOT_AGENT_ONLY`, dual-OTA partition layout, HTTPS download into the inactive slot + reboot —
   all built and verified against real hardware earlier this session (the `esp-claw-2` project).
2. **Platform-side control-plane bookkeeping — entirely new, and buildable *today* independent of
   the firmware constraint:** firmware binary storage (MinIO, once introduced per §27), version
   metadata, target device-group rollout tracking, progress percentages, the
   `2% → 10% → 25% → 50% → 100%` rollout curve from the original brief. **None of this requires
   the device to be remotely triggerable yet** — it can be built and used manually (operator
   triggers `ota_update` via the conversational/agent path today, platform just tracks what
   happened) before the deterministic trigger path exists.

The deterministic trigger path (platform calls `ota_update` over raw MQTT for a whole device
group) is blocked on the same `cap_platform` firmware extension as §18/§25 — sequence the platform
work to be useful *without* that extension first (bookkeeping + manual-trigger tracking), then
wire in automatic dispatch once the firmware side exists. Rollback: `cap_ota`'s dual-OTA slot
already gives a natural rollback target (boot the other slot) — platform-side rollback is "record
the previous version as `target`, dispatch `ota_update` with its stored URL again," no new
firmware primitive needed for that part.

### 24. Edge Gateway Architecture

Covered in §15. Restated as a decision: **not needed for MVP/V1**, add only when a concrete site
has connectivity/bandwidth/privacy constraints that direct-device-to-cloud-broker can't satisfy.
When it is built, it's a new deployable (not a platform module) — likely a small always-on
process at a site doing local MQTT bridging + local MCP aggregation (§19b) + local
store-and-forward for that site's devices specifically (distinct from each device's own
already-working local offline behavior, §15).

**Offline-first, restated precisely given what's real:** each device already tolerates broker
disconnection on its own (reconnect with backoff, local rules continue via `claw_event_router`).
What the *platform* needs to add, once telemetry exists (§13), is store-and-forward **on the
device or gateway side** for telemetry generated while disconnected — genuinely new firmware or
gateway work, not something the current three-leaf MQTT scheme provides. Not needed until §13's
telemetry decision is made.

### 25. AI Agent Architecture

The brief's diagram (User → Central AI Agent → Device Registry → Discover Device → Discover
Capabilities → MCP → ESP-Claw → Tool) maps cleanly onto what already exists, with one gap:

- Device Registry, capability discovery: **exist today** (Phase 6).
- Reaching a device's tool: **exists today** via `CommandsService` → MQTT command envelope, for
  any `CALLABLE_BY_LLM` capability that isn't restricted.
- **The gap isn't AI-specific — it's the same authorization gap as §10.2:** `CommandsService`
  currently has no policy check at all; *any* caller of the REST endpoint can dispatch *any*
  non-restricted capability to *any* device. Before a "Central AI Agent" is safe to wire up, that
  same authorization layer (§12's Policies module) needs to sit in front of
  `CommandsService.dispatch()` — for human operators and an AI agent alike. Treating this as an
  AI-specific problem would mean building the guard twice.
- Audit: `commands`/`command_results` already persist every dispatch with its result — a real,
  working audit trail today, just not yet exposed as a queryable `audit_logs` view or extended to
  cover config/OTA/auth events once those exist.
- Rate limiting: not implemented anywhere yet; belongs at the API-gateway/NestJS-guard level,
  applies equally to human and AI callers.

---

## PART C — DECISION TABLE

| Technology | Verdict | Why |
|---|---|---|
| TypeScript / NestJS | **KEEP** | working, correct fit for a modular monolith at this stage |
| Go | **NOT NEEDED** | no justification to fragment the monolith into two backend languages |
| PostgreSQL | **KEEP** | working, correct for control-plane relational data |
| TimescaleDB | **KEEP — ADD NOW (first hypertable)** | extension already installed and unused; the first telemetry table (§13) is the natural moment to add the hypertable, not a new technology decision |
| Redis | **ADD LATER** (Phase 8 trigger: horizontal scale or WS session fanout) | not needed at one instance / no WebSocket yet |
| NATS JetStream | **ADD LATER** (trigger: telemetry exists **and** (independent consumer **or** multi-instance)) | premature before telemetry exists at all; `EventEmitter2` + defined envelope is correct now (§20) |
| MinIO | **ADD LATER** (trigger: OTA firmware-binary storage work starts, §23) | nothing needs blob storage yet |
| OpenTelemetry | **ADD LATER** (trigger: >1 backend instance or telemetry-ingest module needs its own health signal) | one process, console logs are sufficient today |
| Prometheus | **ADD LATER**, bundled with OTel | same reasoning |
| Grafana | **ADD LATER**, bundled with OTel/Prometheus | same reasoning |
| Loki | **NOT NEEDED YET** | stdout logs captured by Docker are enough pre-multi-instance |
| Tempo | **ADD LATER**, bundled with OTel | distributed tracing only matters once the system is actually distributed |
| Keycloak | **NOT NEEDED NOW** (revisit at multi-tenant/SSO stage) | single-tenant, no SSO requirement; plain JWT + local users covers Phase 10 |
| HashiCorp Vault | **NOT NEEDED NOW** (revisit once per-device credential issuance/rotation exists) | today's secret surface (broker URL, future JWT secret) is fine as env vars |
| K3s | **NOT NEEDED** (revisit only if/when an Edge Gateway deployable needs local orchestration) | no Edge Gateway built; Compose is correct for the backend |
| Kubernetes | **NOT NEEDED** | premature at 10–1000 device / one-backend-instance scale; bottleneck there is DB/broker, not compute orchestration |
| Docker Compose | **KEEP** | correct for dev and small production per the brief's own §24 |
| Tailscale | **KEEP** | already proven this session for device reachability and even this platform's own dev-DB access |
| WireGuard | **KEEP AS-IS (device-side option, not a platform dependency)** | already shipped on-device (`cap_vpn` wireguard mode) for devices that can't use the Tailscale-gateway model; nothing for the platform to add |
| MCP (client+server) | **KEEP / real today** — Gateway aggregation is **ADD LATER** | device-side MCP already works over the existing command path (§19.1); inbound aggregation (§19.2) needs a design decision first and no consumer (Central AI Agent) exists yet to justify building it before it's needed |
| WebSocket | **ADD LATER** (Phase 8, once Phase 7's dashboard exists) | nothing to push real-time updates to yet |
| REST | **KEEP** | correct, working transport; needs OpenAPI + versioning + pagination added incrementally |
| EMQX / Mosquitto / HiveMQ / VerneMQ | **NOT NEEDED** | reconfirms Phase 1 decision #1 — CloudAMQP is the user's own existing broker; self-hosting one is not justified by anything new found this pass |

---

## Questions (only what genuinely needs your decision — nothing answerable by engineering judgment)

1. **CloudAMQP plan/capabilities**: does the broker in use support per-device MQTT credentials or
   client certificates, or only the single shared username/password currently configured? This
   determines whether §22's device-identity gap is closed by broker configuration alone or needs
   new firmware/platform work.
2. **Telemetry direction (§13)**: start with Option B (poll existing capabilities like
   `get_system_info` for system/network metrics, zero firmware changes) for MVP, and treat Option A
   (a real `telemetry` MQTT leaf + on-device sampling) as later firmware work once there's an
   actual sensor-data need beyond system metrics — confirm this is the right order, or is sensor
   telemetry (temperature/humidity/etc.) needed sooner than system metrics?
3. **`cap_platform` firmware extension** (signed-token path for restricted capabilities at scale —
   Phase 1 §item-8, referenced again in §18/§23/§25 here): is building this on the firmware side
   in scope for this workstream, or should the platform be designed to work indefinitely within
   the "restricted capabilities only reachable via the conversational path" constraint?
4. **MCP inbound aggregation** (§19.2): confirm the recommended path — devices announce their MCP
   server's reachable URL over the existing `status` topic (small firmware addition), platform
   proxies directly — versus waiting for a per-site Edge Gateway to exist first.

Everything else in this document is a judgment call I'm comfortable owning and proceeding on
without asking — per the audit's own instruction not to ask what a sound engineering decision can
resolve.

---

## Decisions Locked (all four confirmed "yes")

1. **Per-device MQTT credentials/certs**: move toward per-device identity, away from the single
   shared broker credential. **Important dependency discovered while sequencing this**: actually
   *pushing* new credentials to a device requires either manual local reconfiguration (today's only
   path — WebUI/Telegram, since `mqtt_configure` is `ROOT_AGENT_ONLY`) or the deterministic
   `cap_platform` path from decision #3. So #1 is gated by #3 for automated rollout; what the
   platform *can* build now, independent of #3: a `Provisioning`/credential-issuance module that
   generates and stores per-device credential material (so the target state and audit trail exist),
   applied manually per device until #3 lands.
2. **Telemetry via Option B** (poll existing capabilities, zero firmware changes) — confirmed.
   **Implemented this pass** — see §13-addendum below.
3. **`cap_platform` firmware extension** (HMAC-signed short-lived command tokens for
   `RESTRICTED`/`ROOT_AGENT_ONLY` capabilities) — confirmed, **implemented and live-verified
   on real hardware** (`ecda3b4ff7d4`) in a follow-up pass. See the updated §A below — the shipped
   design differs from the original proposal in two deliberate, documented ways.
4. **MCP server URL announced on the `status` topic** — **not implemented**. A follow-up pass
   discovered that `cap_mcp_server` is never actually started in the `edge_agent` application (it's
   only wired up in a separate example app, `application/mcp_server_point`) — announcing an
   `mcp_url` would describe a feature the real deployed firmware doesn't run. This is a scope
   decision (add a real MCP server to `edge_agent`?), not a firmware bug to quietly fix — see the
   updated §B below.

### §13-addendum — Telemetry (Option B), implemented

New `telemetry` module: a `TelemetryPollerService` periodically dispatches a fixed set of
**already-real, already-exact** capability calls per online device — `mqtt_status`, `vpn_status`,
`network_status`, `ota_status` (all four JSON shapes verified exactly, because I authored all four
capabilities' response bodies myself earlier this session in `esp-claw-2`) — through the *existing*
`CommandsService`/`MqttService.sendCommand()` path (no new device-facing mechanism). Each
capability's `result` string is `JSON.parse`d; every top-level scalar field (number/boolean) is
stored as one narrow time-series row `(device_id, recorded_at, metric, value)` in a new
`telemetry` hypertable. Deliberately schema-tolerant (walks whatever scalar fields exist) rather
than hardcoding field names per capability — works today for the four capabilities above and for
any future one without a migration. A capability is only polled for a device that has actually
reported its owning group (Phase 6 `device_capabilities`) — a heterogeneous fleet won't get a
failed-command every cycle for a capability it doesn't have.

**Verification performed:**

```
pnpm -r build   → exit 0
pnpm -r test    → 40 passed (protocol 22, backend 18 — 6 local-api-client, 5 mqtt integration,
                  7 new telemetry-extraction tests using the exact vpn_status/mqtt_status shapes
                  authored in esp-claw-2 this session)
```

**✅ Live-verified in a follow-up pass**: the tailnet came back (`tailscale status` shows
`100.108.45.123` online), TCP 5432 reachable, so the previously-blocked verification was
completed for real:

```
pnpm exec typeorm-ts-node-commonjs migration:run -d src/database/data-source.ts
  → AddDeviceCapabilities1700000000003 executed
  → CreateTelemetryHypertable1700000000004 executed (create_hypertable('telemetry', 'recorded_at'))

node dist/main.js  (DATABASE_URL → postgres://esp_claw:esp_claw_dev_only@100.108.45.123:5432/esp_claw_platform)
  → TypeOrmModule/DevicesModule/CommandsModule/TelemetryModule all initialize cleanly
  → "Telemetry poller started (every 60000ms)" logged, no errors with zero devices registered
  → GET /health          → 200 {"status":"ok",...}
  → GET /devices         → 200 [] (correctly empty — no MQTT_URL configured in this pass, so no
                                    device has ever reported presence into *this* Postgres)
  → GET /devices/x/telemetry → 200 [] (correct shape, no crash on an unknown device)
```

**What this proves**: migrations `0003`/`0004` apply cleanly to a real (non-aedes, non-local)
Postgres+TimescaleDB instance, the app boots and serves traffic against it, and the telemetry
poller starts without error. **What's still not verified**, and can't be from this environment:
the poller actually recording a sample from a real device — that needs a real `MQTT_URL`
(CloudAMQP credentials) plus at least one online device, neither of which this pass has access to.
Do this once both are available:

```bash
# in apps/backend/.env, add: MQTT_URL=mqtts://<user>:<pass>@<your-instance>.rmq.cloudamqp.com:8883
pnpm --filter @esp-claw/backend start
# wait one TELEMETRY_POLL_INTERVAL_MS cycle (default 60s) with at least one online device, then:
curl "localhost:3000/devices/<device_id>/telemetry"
# expect: rows for whichever of mqtt_status/vpn_status/network_status/ota_status that device's
# discovered capabilities include
```

### Firmware work (esp-claw-2)

**A. `cap_platform` — signed command tokens for restricted capabilities — IMPLEMENTED, LIVE-VERIFIED**

Lets the platform trigger a `RESTRICTED`/`ROOT_AGENT_ONLY` capability (e.g. `ota_update`,
`mqtt_configure`, `vpn_connect`) deterministically over MQTT, without weakening `ROOT_AGENT_ONLY`'s
existing protection against the conversational/LLM path or against arbitrary MQTT senders. Shipped
in `esp-claw-2` commit `bb9df36`, new Kconfig option `APP_CLAW_CAP_PLATFORM` (default `n`).

Two deliberate deviations from the original proposal above, made during implementation:

- **Two tools, not one**: `platform_configure` (`ROOT_AGENT_ONLY`, sets the shared secret — NOT
  reachable over MQTT, by the same caller-check this whole mechanism is built around) and
  `platform_exec` (`RESTRICTED`, not `ROOT_AGENT_ONLY` — reachable over MQTT, verifies the token).
  The secret is deliberately **not** added to the generic `/api/config` field table: that endpoint
  still doesn't mask secrets on GET (§10.10's known gap), and a secret whose only job is signing
  security tokens shouldn't sit next to that leak. It lives in its own NVS namespace
  (`cap_platform`), independent of `app_config_t`.
- **No separate `input_hash` field** — the token payload is
  `{device_id, capability, input, issued_at, expires_at, nonce}` with the target's real `input`
  embedded *directly* in the signed payload, and the signature covers the ASCII base64url text of
  that payload (JWT-HS256-shaped), not the decoded JSON bytes. This avoids a real
  canonicalization risk in the original design: hashing a separately-transmitted `input` object
  requires the issuer and verifier to agree on one exact re-serialization of that JSON, which is
  an unnecessary source of bugs. Signing the base64url text directly means both sides only need to
  agree on one base64url encoding of one JSON string — nothing to canonicalize.

**Live-verified** on real hardware (`ecda3b4ff7d4`, the same device used throughout this session),
via the device's console (`cap call platform_configure {...}` / `cap call platform_exec {...}`),
targeting the real `vpn_connect` capability (`ROOT_AGENT_ONLY`, side-effect-free in this device's
current tailscale-gateway mode — it returns `{"ok":false,"error":"not in wireguard mode"}` without
mutating any state, making it a safe live test target):

```
1. platform_configure with a fresh random secret → {"ok":true,"note":"Platform secret set (32 bytes)..."}
2. platform_exec, valid token, target=vpn_connect → {"ok":false,"error":"not in wireguard mode"}
   (vpn_connect's REAL response — proves the signature verified and the internal escalation to
   CLAW_CAP_CALLER_ROOT_AGENT actually reached and executed the target capability)
3. platform_exec, SAME token replayed        → "Error: token nonce already used (replay)"
4. platform_exec, tampered signature (1 byte flipped) → "Error: invalid token signature"
5. platform_exec, correctly-signed but wrong device_id → "Error: token was issued for a different device"
6. platform_exec, expired token (expires_at in the past) → "Error: token expired or not yet valid"
```

All six behaved exactly as designed; the device rebooted twice during testing (unrelated USB-CDC
re-enumeration flakiness on this board, not a firmware crash) and came back up cleanly each time,
with the real CloudAMQP connection re-establishing on its own.

**Not yet built**: the platform-side `TokenService` that would actually issue these tokens in
production (encrypted-at-rest per-device secret storage, `CommandsService` wiring to attach a
token when targeting a restricted capability). The test above issued tokens by hand (PowerShell +
`HMACSHA256`) to prove the device-side verifier is correct; a real `TokenService` is separate,
not-yet-started work.

**B. MCP server URL on `status` — NOT IMPLEMENTED (scope question, not a design detail)**

While implementing (A), a check of what `edge_agent` actually runs found that **`cap_mcp_server`
is never initialized or started in `edge_agent`** — `cap_mcp_server_init()`/`_start()` are only
called from a separate, unrelated example application (`application/mcp_server_point/main/main.c`).
`edge_agent`'s own `app_capabilities.c` has zero references to `cap_mcp_server` at all. This means
§4/§19's "a device is both an MCP client and an MCP server" claim is only half-true for the actual
deployed firmware: `cap_mcp_client` is real and wired up in `edge_agent`; `cap_mcp_server` is not.

Announcing an `mcp_url` on the `status` topic would therefore describe a server that doesn't exist
on real devices — not implemented, to avoid exactly that. This is now an open scope question for
you, not a firmware detail: do you want `edge_agent` to actually run an MCP server (pulling in
`cap_mcp_server` + `mcp_mdns` + an HTTP+mDNS surface, real flash/RAM/attack-surface cost), or does
the MCP Gateway design (§19) need to be re-scoped around "outbound only" (§19.1, already real and
unaffected by this) without an inbound-aggregation half at all?
