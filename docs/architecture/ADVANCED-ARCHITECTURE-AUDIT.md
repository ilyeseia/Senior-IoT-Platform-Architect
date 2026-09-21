# Advanced Architecture Audit — ESP-Claw IoT / Edge AI Platform

Status: **audit written 2026-09-20 with no code changed; the four §26 decisions were then approved (all "yes") and acted on** —
see "Follow-up" below. The findings, evidence labels and target architecture in this document are unchanged.

### Baseline note (added 2026-09-21)
This audit was written against local `HEAD` `fafbae0`. `origin/main` (`fcc8e15`, six commits ahead) already
contains work the audit describes as missing, so read §1, §3, §6, §8, §10-B2, §12 (identity) and §18 (twin)
with these corrections:
* **Identity/auth exists** (`identity/`: bcrypt users, HS256 JWT 12 h, global `JwtAuthGuard`, `@Public()`, first-admin bootstrap) — B2 is closed by it, not by an API token.
* **Digital Twin v1 exists** (`twin/`, table `device_shadows`, `GET /devices/:id/shadow`, `PUT …/desired`, drift as a key-wise `!==`); the poller feeds `reported`. No bindings, reconciler, `sync_status`, or per-key metadata yet — §18's design is still the target.
* **Migrations 0003–0006 are applied on the live dev DB** and `telemetry` is a hypertable (live-verified by an earlier session and re-confirmed read-only on 2026-09-21).
* `cap_platform` was live-verified on hardware in its **original** form (commit `bb9df36`, per `main`'s docs); the changes in `FIRMWARE-HARDENING.md` (allow-list, heap buffers) are new and not yet run on a device.
* `main`'s docs claim `cap_mcp_server` is not started in `edge_agent`; that was true then, but firmware commit `ddcfc92` (later) starts it, which is why S3 matters.

### Review of what landed on `main` (code read, not executed against a live server)
| ID | Sev | Finding |
|---|---|---|
| **I1** | Med | `POST /auth/register` is public while the `users` table is empty: on a fresh deployment the first caller to reach the API becomes admin (bootstrap takeover). The `count()`-then-`save()` is not atomic, so two concurrent first requests can create two admins (only `email` is unique). |
| **I2** | Med | No throttling on `POST /auth/login` (bcrypt cost 12): brute force and CPU exhaustion are unbounded. |
| **I3** | Low/Med | `role` is stored and put in the JWT but nothing enforces it (no RBAC); tokens live 12 h with no revocation; HS256 with one shared secret. |
| **T1** | Med | `TwinService.mergeReported` writes `reported[metric]` with **unqualified** metric names, so `connected` from `mqtt_status` and from `vpn_status` overwrite each other (same defect as B9 in telemetry). |
| **T2** | Low | `PUT /devices/:id/shadow/desired` accepts any JSON object: no key allow-list, size or depth limit. Nested values always report drift (`!==`). `desiredVersion` also bumps on no-op writes (documented as intended). |
| **T3** | Low | Read-modify-write of two JSONB columns without locking; safe today only because the poller is sequential. |

### Follow-up (same day, after approval)
| §26 decision | Result | Record |
|---|---|---|
| 1. Firmware hardening | S1–S5 implemented in the `esp-claw-2` working tree (uncommitted); `idf.py build` passes and `cap_platform`/`cap_ota` compile, but **nothing was run on hardware** | [FIRMWARE-HARDENING.md](FIRMWARE-HARDENING.md) |
| 2. CloudAMQP per-user topic permissions | Approved as the direction; **plan support is still [unverified]** — must be confirmed against the actual account before Stage 2 | — |
| 3. Stage 0 stabilize | Done (B1, B3, B4, B7, B8, B12 + new B13; B2 by the JWT module already on `main`); 90 backend tests on top of `origin/main` | [STAGE0-STABILIZATION.md](STAGE0-STABILIZATION.md) |
| 4. MCP spike | Static SDK analysis: no protocol obstacle. Probe script written and tested against a mock; **not yet run on a device** | `spikes/mcp-device-probe/`, FIRMWARE-HARDENING.md |

Original status line: AUDIT + PROPOSAL ONLY. No code was changed.
Supersedes the *analysis* parts of `ARCHITECTURE-EVOLUTION.md` (kept for history; see §0.2 for
what in it is stale). Nothing below is implemented until the decisions in §26 are confirmed.

## 0. Method and evidence labels

Every claim carries one label. Nothing is labelled stronger than what was actually done.

| Label | Meaning |
|---|---|
| **[code]** | Verified by reading the source in this session (platform repo or `esp-claw-2` firmware at commit `e0738c6`). |
| **[run]** | Verified by executing something. Only the unit/integration test suites were run (backend 18 + protocol 22 = 40 passed). |
| **[infer]** | Follows from code I read, but I did not execute it. Treat as "very likely", verify before acting. |
| **[unverified]** | Depends on something I could not check (real Postgres via the tailnet, real hardware, CloudAMQP plan, third-party library behaviour). |

**Not done:** no Postgres/migration run (tailnet DB unreachable), no hardware test, no
exploit attempt, no broker inspection. Security findings in §4.3 are code-reading results, not
demonstrated exploits.

### 0.1 Scope read
Platform: all of `apps/backend/src`, `packages/esp-claw-protocol/src`, 4 migrations, tests, compose,
env, README, 7 architecture docs. Firmware (`esp-claw-2`): `cap_mqtt`, `cap_platform`, `cap_ota`,
`cap_mcp_server`, `cap_mcp_bridge`, `cap_router_mgr`, `cap_lua` (descriptors), capability flags of
every `cap_*` group, `claw_cap.c` authorization, `claw_event_router` (actions/caller), `claw_memory`
(flags), `claw_agent_mgr` (caller assignment), `mqtt_manager.c`, the HTTP route table, `app_config.c`
defaults, `sdkconfig.defaults`.

### 0.2 Corrections to the previous `ARCHITECTURE-EVOLUTION.md`
| # | Previous claim | Reality [code] |
|---|---|---|
| 1 | "No MCP tool-listing endpoint exists." | `cap_mcp_bridge` (commit `b8a1335`) registers `claw_list` and `claw_call` on the device MCP server. `claw_list` returns tool **names (+descriptions)**; input schemas are deliberately dropped (8 KB MCP result limit). |
| 2 | `cap_platform` firmware is "designed, pending confirmation". | Implemented and committed (`bb9df36`): `platform_configure`, `platform_exec`. The **platform side (TokenService) does not exist**. |
| 3 | "Restricted capabilities are unreachable over raw MQTT." | True only for tools flagged `ROOT_AGENT_ONLY`. A privilege-escalation chain exists through non-root tools (§4.3-S1) and `RESTRICTED` is **not enforced anywhere** (§4.3-S6). |
| 4 | Command DB id equals the MQTT wire id (entity comment). | **False.** `CommandsService` creates one UUID, `MqttService.sendCommand` creates a different one (§10-B1). |
| 5 | "No telemetry ingestion", "TimescaleDB has zero hypertables". | Telemetry module + hypertable migration `0004` exist (not run live). Doc is internally inconsistent. |
| 6 | README: "Phases 1–5 complete". | Code contains Phase 6 + telemetry. |
| 7 | First-person statements ("I built this firmware earlier this session… verified on hardware"). | Not verifiable from the repo. Treated as **[unverified]** here. |

---

## PART A — CURRENT STATE

### 1. Current Architecture
A NestJS modular monolith, already shaped by module boundaries but with no enforcement of them.

```
AppModule
 ├─ ConfigModule(global, zod)  ├─ EventEmitterModule (in-process bus)
 ├─ DatabaseModule ──imports entities of ALL feature modules (central registry)
 ├─ HealthModule (static "ok")
 ├─ EspClawModule  TopicService, LocalApiClient (HTTP introspection), EspClawController(debug)
 ├─ MqttModule ──> EspClawModule        MqttService (only mqtt.js user) + MqttController(debug, unauth)
 ├─ DevicesModule ──> EspClawModule     @OnEvent("device.status")
 ├─ CommandsModule ──> Mqtt, Devices
 └─ TelemetryModule ──> Devices, Commands   (poller → CommandsService.dispatch)
```
Good: `MqttService` never imports `DevicesService`; presence flows via an event. Bad: DB entity
registry is central (`database.module.ts`, duplicated in `data-source.ts`), so no module owns its
schema; no enforcement of import direction; telemetry depends on the *command* path.
`main.ts` has no `ValidationPipe`, no `enableShutdownHooks()`, no CORS/helmet, no global prefix or
versioning [code].

### 2. Current Technology Stack [code]
NestJS 10, TypeScript 5.5, TypeORM 0.3 (`synchronize:false`, `migrationsRun:true`), `pg`, `mqtt` 5.10
(protocol 3.1.1 default), zod, `@nestjs/event-emitter`, Vitest 2 (+ embedded `aedes` broker), pnpm
workspaces, Node ≥ 20 (local: 22.22). DB image `timescale/timescaledb:latest-pg16`. Not present:
Redis, NATS, MinIO, any auth lib, OpenAPI, WebSocket, validation lib (`class-validator`), logger,
metrics, frontend. `dotenv` is imported by `data-source.ts` but not declared as a dependency.

### 3. Current Data Flow [code]
```
Presence : device status(retained,QoS1) → MqttService("#") → emit device.status → DevicesService upsert
Command  : POST /devices/:id/commands → INSERT commands(id=A,pending)
           → MqttService.sendCommand() generates id=B → publish {id:B,action:"capability",name,input}
           → in-memory Map<B,…> → device response {id:B,ok,result} → resolve → classify → INSERT command_results
Telemetry: setInterval(60s) → for each online device × 4 caps → CommandsService.dispatch()  (creates a
           commands + command_results row per poll) → JSON.parse(result) → scalar fields → telemetry rows
Discovery: POST /devices/:id/capabilities/refresh {baseUrl} → HTTP GET /api/capabilities → device_capabilities
```
No push telemetry, no WebSocket, no twin, no alerts, no automation, no OTA bookkeeping.

### 4. Current ESP-Claw Integration

#### 4.1 What the device really is [code]
* Capability model `claw_cap_descriptor_t` (id, family, kind, `cap_flags`, JSON-schema), grouped `cap_*`.
* Three MQTT leaves only: `status` (retained birth/LWT `{"online":bool}`), `command`, `response`.
  Command bridge reads only `id`, `action`, `name|capability`, `input`, `text|message`; extra fields
  are ignored. Response: `{id, capability, ok, result}`. MQTT version: no `protocol_ver` set → 3.1.1.
* Not present on device: telemetry/events/logs/config leaves, MQTT5, telemetry store-and-forward,
  bootloader rollback (`CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE` absent, `esp_ota_mark_app_valid…`
  never called), secure boot, flash/NVS encryption (none in `sdkconfig.defaults`).
* On-device engines that already exist: agent loop + sub-agents (`cap_agent_mgr`), local rules
  (`claw_event_router`: CALL_CAP / RUN_AGENT / RUN_SCRIPT / SEND_MESSAGE / EMIT_EVENT / DROP),
  scheduler (`cap_scheduler`), Lua, memory (`memory_store/recall/list/update`, all `CALLABLE_BY_LLM`),
  MCP client (`mcp_list_tools`, `mcp_call_tool`, `mcp_discover`) and MCP server (+`claw_list`/`claw_call`).

#### 4.2 Reachability matrix — who can invoke what [code unless noted]
| Channel | Authenticated by | Effective caller class | Reaches |
|---|---|---|---|
| MQTT `action:"capability"` | broker credential only | `SUB_AGENT` | every `CALLABLE_BY_LLM` tool **not** `ROOT_AGENT_ONLY` |
| MQTT free text (`text`/raw payload) | broker credential only | routed to the agent via the event router → root agent + LLM **[infer]** | anything the root agent may call, subject to LLM behaviour |
| MCP `claw_call` (HTTP, **enabled by default**: `APP_DEFAULT_MCP_ENABLED="true"`) | **none** | `SUB_AGENT` | same as MQTT capability path |
| `platform_exec` (signed token) | HMAC-SHA256 token | escalates to `ROOT_AGENT` | any `CALLABLE_BY_LLM` tool incl. root-only |
| Router rule `CALL_CAP` (default), Lua `capability.call` (default) | device-owner-authored | `SYSTEM` (authorization skipped) | everything |
| Local HTTP `/api/*` | **none** | n/a | `/api/config` returns `mqtt_password`, `llm_api_key`, `wg_private_key` (no masking in code), files, Lua, restart |

Tools reachable by `SUB_AGENT` that matter for security: `lua_run_script`, `lua_run_script_async`,
`write_file`, `delete_file`, `move_file`, `http_request`, `add_router_rule`, `update_router_rule`,
`scheduler_add`, `register_skill`, `memory_*`, `mqtt_subscribe`, `mqtt_publish`.

#### 4.3 Security findings in the integration surface (firmware-side; fixes live in `esp-claw-2`)
| ID | Sev | Finding | Label |
|---|---|---|---|
| **S1** | High | **SUB_AGENT → SYSTEM escalation chain.** `write_file` (create a Lua file) + `lua_run_script` (path) → Lua `capability.call` runs as `SYSTEM` and skips authorization; or `add_router_rule` with a `CALL_CAP` action (caller defaults to `system`). Either bypasses `ROOT_AGENT_ONLY` and reaches `ota_update`, `mqtt_configure`, `vpn_configure`. Entry points: anyone able to publish to a device `command` topic, or any host that can reach the device MCP port. | each link [code]; end-to-end chain **[infer]**, not executed |
| **S2** | High | MQTT free-text goes to the root agent; a publisher can attempt prompt injection against an agent holding root tools. | [infer] |
| **S3** | High | Device MCP server is on by default, HTTP, unauthenticated; `claw_call` exposes S1's tools to the LAN/tailnet. | [code] |
| **S4** | Med | `cap_platform`: (a) no allow-list of target capabilities — a valid token can target any tool incl. `platform_configure` (secret rotation/takeover); (b) replay window is 16 nonces in RAM, cleared on reboot (60 s TTL is the real defence); (c) secret in plain NVS, no NVS/flash encryption; (d) payload segment capped at 512 chars (~384 B decoded) — large configs won't fit; (e) one secret per device with no derivation scheme. The verification order (signature → time → device_id → nonce) is sound and constant-time. | [code] |
| **S5** | Med | OTA: `ota_update` takes only a URL; TLS is the only integrity check, no image hash/signature verification, no rollback. | [code] |
| **S6** | Low/Med | `CLAW_CAP_FLAG_RESTRICTED` is never enforced by `claw_cap.c` — only `ROOT_AGENT_ONLY` is. Descriptor comments imply otherwise. | [code] |
| **S7** | Med | `llm_config_command` is `RESTRICTED` but not `CALLABLE_BY_LLM`; agent-class callers (including `platform_exec`'s inner call) require `CALLABLE_BY_LLM`, so **device LLM provider/model cannot be pushed remotely** at all today. | [infer] |

Consequence for the platform design: **the broker is currently the only authentication boundary
for device control.** Per-device broker credentials + topic ACLs (§22) are therefore not a
"later hardening" item — they are what makes S1/S2 unreachable for anyone but the platform.

### 5. Current MQTT Architecture [code]
* Topic `{base}/{device_id}/{leaf}`; `base` may contain `/` (tenant scoping works today, no firmware change).
* Backend: one connection, random clientId, `reconnectPeriod 2s`, **subscribes to `#`** and filters in
  code. On a shared broker this receives every client's traffic (privacy/load); it also breaks the
  moment topic volume grows. Subscribe to `{prefix}/#` at minimum.
* Command correlation: in-memory `Map` (single instance only). QoS1 publish, QoS1 subscribe.
* No clean-session/persistent-session decision made; commands sent while the device is offline are
  handled by broker session state, not by the platform (no expiry — a queued command may execute
  hours later) **[infer]**.
* MQTT is used directly by `MqttService`, and `MqttController` exposes an **unauthenticated command
  endpoint that bypasses `CommandsService`** (no DB row, no audit) and accepts an arbitrary `baseTopic`.

### 6. Current API [code]
REST, unauthenticated: `GET /devices` (there is no `POST /devices`; devices self-register), `GET /devices/:id`,
`GET|POST /devices/:id/commands`, `GET /devices/:id/capabilities`, `POST …/capabilities/refresh`,
`GET /devices/:id/telemetry`, `GET /health`, debug `GET /esp-claw/topics`, `GET|POST /mqtt/*`.
Missing: versioning, pagination (only a `limit` on telemetry), sorting, filtering, OpenAPI, WebSocket,
rate limiting, request validation (DTOs are TypeScript interfaces → no runtime checks), error envelope.

### 7. Current Database [code; migrations not run live]
`devices`, `device_capabilities`, `commands`, `command_results`, `telemetry` (hypertable, PK
`device_id,metric,recorded_at`), `migrations`. Column naming is inconsistent (`deviceName` camelCase vs
`device_id`, `value_numeric` snake_case). No `org_id`, no users/orgs/groups/firmware/ota/alerts/rules/
audit tables. No Timescale retention, compression, or continuous aggregates. `migrationsRun:true`
runs migrations on **every** instance boot (race with >1 replica).

### 8. Current Authentication [code]
None. `JWT_SECRET` and `REDIS_URL` are validated but unused. Devices share one broker credential.
On-device: HMAC token mechanism exists (`cap_platform`) but is unused by the platform.

### 9. Current Deployment [code]
`docker-compose.yml`: Postgres only, image tag `latest-pg16` (unpinned), dev password in the file
(labelled dev-only), no healthcheck. Backend runs from the host, no Dockerfile, no TLS, no backups.

### 10. Current Problems (ranked)
Bugs and defects verified in code:

| ID | Sev | Problem |
|---|---|---|
| **B1** | High | **Correlation id split.** DB `commands.id` ≠ wire id (`sendCommand` ignores the caller's id). A DB command cannot be traced to its MQTT message/response; the entity's doc-comment claims the opposite. Blocks tracing and idempotent retries. |
| **B2** | High | No authN/authZ anywhere; `dispatch()` also auto-creates a device row for any `deviceId` string (registry poisoning) with a hard-coded `"espclaw"` base topic. |
| **B3** | High | **SSRF**: `POST …/capabilities/refresh {baseUrl}` makes the backend fetch an arbitrary host (path is fixed, host/port are not). |
| **B4** | High | Unauthenticated, unaudited command endpoint `POST /mqtt/devices/:id/commands` + arbitrary `baseTopic` (can address another tenant's prefix). |
| **B5** | High | **Telemetry via commands does not scale and pollutes audit.** 4 caps × N devices per minute, sequential, 8 s timeout each: 100 unreachable devices ⇒ ≥ 3 200 s per cycle (≫ 60 s, ticks skipped). Every poll writes 2 relational rows: at 1 000 devices ≈ 8 000 rows/min ≈ 11.5 M/day into `commands`/`command_results`, mixed with operator commands (no `origin` column) **[infer]**. |
| **B6** | Med | Presence race: async `@OnEvent` handlers, no sequence/timestamp; rapid online/offline (retained + LWT) can persist the wrong final state **[infer]**. |
| **B7** | Med | `commands` rows stay `pending` forever if the process dies mid-command (no reaper); HTTP request blocks up to 15 s. |
| **B8** | Med | No `enableShutdownHooks()` → `OnModuleDestroy` (MQTT close, timers) does not run on `SIGTERM` in Docker. |
| **B9** | Med | Telemetry metric names are unqualified (`connected` from two capabilities collide); PK excludes `source`; `recorded_at` is server time, not device time; a duplicate `(device,metric,ms)` aborts the whole batch insert. **[infer]** on field names. |
| **B10** | Med | Two sources of truth for presence (`MqttService` map vs `devices` table). |
| **B11** | Low | No test covers `CommandsService`, `DevicesService`, poller, controllers, or migrations. |
| **B12** | Low | Docs stale (§0.2); `dotenv` undeclared; unpinned DB image. |

Architectural gaps (vs. the target): no identity/multi-tenancy, no twin, no event bus abstraction, no
OTA control plane, no agent/MCP layer, no observability, no offline/edge story, no policy layer.

---

## PART B — TARGET ARCHITECTURE

### 11. Target Architecture
Principle: **Device Gateway → internal events → domain modules**; MQTT/MCP/HTTP are adapters, never
imported outside the gateway.

```
                    Users / Central AI Agent / Automation
                                    │ REST · WebSocket · MCP(facade)
                         ┌──────────▼───────────┐
                         │  API + Policy (PEP)   │  authn · RBAC · tool authz · rate-limit · audit
                         └──────────┬───────────┘
  ┌─────────────── CONTROL PLANE ───┴─── DATA PLANE ───────────────┐
  │ identity  registry  firmware/ota │ commands telemetry twin alerts│
  │ policy    groups    config       │ events   automation(cloud)    │
  └───────────────┬───────────────────┴──────────────┬───────────────┘
                  │        EventBus port (envelope)   │      ← InProcess adapter now, NATS later
                  └──────────────────┬────────────────┘
                     AGENT PLANE: agents · mcp-gateway · tool registry
                                     │
                         ┌───────────▼───────────┐
                         │     Device Gateway     │  MQTT adapter · HTTP-local adapter · MCP adapter
                         └───┬───────────────┬───┘
                             │               │  (optional)
                          ESP-Claw     Edge Gateway → ESP-Claw ×N        OBSERVABILITY: cross-cutting
```
Deployment tiers: dev = Compose; small prod = Compose on one VM; edge = one container (K3s only if
the edge runs ≥ 3 cooperating services); large = Kubernetes. The system must run with **no** edge
gateway, **no** NATS, **no** Redis until their triggers (§27) fire.

### 12. Control Plane
Owns *intent and identity*: `identity` (users, orgs, RBAC, API tokens, service identities), `registry`
(devices, groups, inventory, capability catalog), `firmware/ota` (images, rollouts), `policy`
(who/what may invoke which tool class), `config` (desired configuration, provisioning). Storage:
PostgreSQL schema `control`. Change flow: API → module → event. It may be degraded without stopping
telemetry or local automation.

### 13. Data Plane
Owns *facts and traffic*: `commands` (dispatch/response lifecycle), `telemetry`, `state/twin`,
`alerts`, device `events`. Storage: Postgres schema `data` (commands, twin, alerts) + Timescale
hypertables (telemetry). **Rules that keep the planes separate:** (1) data plane never calls control
APIs synchronously — it reads a cached registry projection fed by events; (2) control plane never
writes `reported_state`; (3) each plane has its own route prefix, permissions, and DB schema; (4)
cross-plane references are IDs only (no cross-schema FKs).

### 14. Agent Plane
Modules: `agents` (registry of Central/Fleet/Device agents), `tools` (dynamic tool catalog per device),
`mcp-gateway`. Fact base: each device already runs a root agent with sub-agents, memory, skills, local
LLM provider config (`cap_agent_mgr` tools are root-only ⇒ readable only via signed `platform_exec`).
Platform's job = **fleet visibility + governed invocation**, not re-implementing agent loops.
Model: `agents(id, kind[device|fleet|central], device_id?, provider, model, status, policy_id)`,
`agent_tools(agent_id, tool, family, flags, schema_hash, risk_class)`. Central/Fleet agents are
platform constructs scoped to a group (Agriculture/Energy/Security/Camera = groups + a policy +
prompt profile), layered above per-device agents. Gap: no remote path to change a device agent's
provider/model (S7).

### 15. Edge Plane
Today each device is already an offline-capable edge node (local rules, scheduler, Lua, LWT,
reconnect). The Edge Plane adds *site-level* services only when a site needs them (§24).

### 16. Observability Plane
Cross-cutting, introduced in two steps: **now** = structured JSON logs (`correlation_id`, `trace_id`,
`device_id`), `/health/live` + `/health/ready` (DB + broker state), `/metrics` endpoint, an
AsyncLocalStorage trace context — zero new infrastructure. **Later** = OTel collector, Prometheus,
Grafana, Tempo, Loki (§27). Metrics to track: API latency histogram; command latency
(dispatch→response) per capability; device RTT; event publish→consume latency; DB query/pool latency;
NATS latency (later); MQTT connect/reconnect/publish-ack; device health (last_seen age, command success
rate, RSSI/heap when exposed). eBPF: study only, for Linux/K8s hosts (e.g., Beyla/Hubble); never on
ESP32; not needed for Compose/VM.

### 17. Device Registry
First-class, extends `devices` (keep id = MAC-derived `device_id`). Facets: **identity** (id, name,
serial), **hardware** (chip/target, flash, PSRAM, board), **firmware** (version, partition/slot, OTA
capable), **esp_claw_version**, **capabilities** (groups + tools, §18-cap), **network** (IP, RSSI,
transport), **health** (last_seen, uptime, error counters), **location** (operator-set, optional geo),
**ownership** (org, project, groups, tags), **security state** (credential type/rotation, `cap_platform`
provisioned, MCP exposed, SSH enabled, last token issued). Storage: typed, indexed columns for what is
queried + a JSONB `inventory` for raw discovered data. Field sources (`/api/status`, `ota_status`,
`get_system_info`, `network_status`) must be confirmed against firmware output **before** the schema is
frozen **[unverified]** — do not guess field names. Supports arbitrary ESP32 variants because nothing
is variant-specific: everything is discovered.
**Dynamic capability model:** `device_capabilities` (group) stays; add `device_tools(device_id, tool,
group_id, family, flags, description, schema JSONB NULL, schema_hash, source, discovered_at)`.
Discovery order: `claw_list` (names+desc) → per-tool schema needs a small firmware addition
(`claw_describe(name)` on the MCP bridge or a status-time schema hash) — otherwise schemas remain
NULL and the dashboard renders a generic JSON form. UI/API adapt from `family` + `schema`; no
capability is hard-coded in the backend.

### 18. Digital Twin
No ESP-Claw shadow primitive exists; the twin is a **platform construct built on capability calls**
(no invented device API).
```
device_twin(device_id PK, desired JSONB, reported JSONB, desired_version BIGINT, reported_version BIGINT,
            metadata JSONB /*per-key ts+source*/, capabilities_hash, health JSONB, sync_status, updated_at)
twin_bindings(profile, key, apply{capability,input_template}, read{capability,path}, restricted BOOL, policy)
```
* `desired` written only by control plane/automation; `reported` only by data plane (telemetry, command
  results, status). Pure function `diff(desired, reported)` ⇒ `sync_status ∈ {in_sync, pending, drifted,
  unreachable, pending_manual}`; emits `device.state.changed` and `device.twin.drifted`.
* Reconciler: on `device.online` or `desired` change, for each key with a binding dispatch a command whose
  idempotency key = `(device_id,key,desired_version)`; confirm by read-back capability (ESP-Claw replies
  are free-text/JSON strings, so "ok" ≠ applied).
* Keys whose binding hits a root-only tool require `platform_exec` (needs TokenService + allow-list, S4)
  else stay `pending_manual`.
* Conflict policy per key: `enforce` | `accept_local` (edge rule changed it) | `alert`. Newest
  `desired_version` wins; `reported` ordered by device timestamp when trustworthy (`ts_quality`), else
  server time. `claw_memory` is agent knowledge, **not** twin state.

### 19. MCP Gateway
Findings that reshape the earlier design [code]: the device MCP server exposes only two tools
(`claw_list`, `claw_call`), both dispatching as `SUB_AGENT` — **the same authority as the MQTT
`capability` path**. mDNS is LAN-local; HTTP MCP needs inbound reachability; the MCP transport/protocol
revision of `esp_mcp` vs. standard MCP clients is **[unverified]** (needs a spike).
Design: the gateway is a **protocol facade**, not a second control path.
1. Platform MCP server for Central/Fleet agents: `fleet.list_devices`, `device.describe`,
   `device.call(device_id, tool, args)` + optional virtual per-device tools synthesized from `device_tools`.
2. Every call passes the PEP (authz, risk class, rate limit, approval, audit) → `commands` module.
3. Transport to device: **MQTT `capability` command by default** (works behind NAT, broker-authenticated,
   already audited). Device MCP-over-HTTP is an optional secondary transport for devices reachable on the
   tailnet/LAN; same permission semantics, so no capability is gained by preferring it.
4. Outbound direction (device as MCP *client*: `mcp_call_tool`) stays an ordinary capability call.
5. Discovery is dynamic and **default-deny**: newly discovered tools get risk class from flags and are
   unusable by agents until a policy grants them.

### 20. Event Architecture
Envelope (superset of the requested one; `organization_id` nullable until identity lands):
```json
{ "event_id":"uuid7","event_type":"device.telemetry.updated","schema_version":1,
  "timestamp":"…","device_id":"…","organization_id":null,"source":"gateway:mqtt",
  "correlation_id":"…","causation_id":"…","trace_id":"…","span_id":"…",
  "sequence":123,"idempotency_key":"…","payload":{} }
```
Catalog (publisher → consumers): `device.registered`(registry → twin, audit) · `device.online/offline`
(gateway → registry, twin, alerts, ota) · `device.telemetry.updated`(telemetry → twin, alerts, automation)
· `device.state.changed`(twin → automation, alerts, ws) · `device.command.created/completed`(commands →
audit, ws, twin) · `device.ota.started/completed/failed`(ota → audit, alerts, registry) ·
`device.alert.created`(alerts → notification, ws) · `agent.started`, `agent.tool.executed`(agents →
audit).
Mechanics: `EventBus` **port** with an in-process adapter now (EventEmitter2 wrapped, not replaced) and
a NATS JetStream adapter later; **transactional outbox** table for events that must survive a crash
(commands, OTA, security, lifecycle); consumers idempotent via `(consumer, event_id)`; ordering key =
`device_id`; retries with backoff + dead-letter after N; per-handler timeout; durable streams only for
audit-class and edge-forwarded subjects. Append-only `event_log` (partial event sourcing) for device
lifecycle, commands, OTA, security, configuration, and important state changes — nothing else.
NATS is justified by **any** of: second backend instance, a consumer with a different failure/scale
domain, or edge store-and-forward (JetStream leaf nodes are the strongest fit) — not before.

### 21. Microservices Evolution Strategy
Path: **Modular monolith → event-driven modules (bus port + outbox) → schema-per-module → extract only
what clears the bar → microservice.** Extraction bar: independent scaling profile **or** independent
failure/security domain **or** independent team/release cadence, *and* clean data ownership.
Verdict now: every service stays a module.

| Service | Why it might split / problem solved | Why it stays a module now | Owns | API | Publishes | Consumes |
|---|---|---|---|---|---|---|
| Device Gateway | protocol termination, edge deployment, connection scaling | must first exist as a module; needed at edge (same code, standalone) | none (stateless; session state only) | internal port; `POST /v1/gateway/*` at edge | `device.online/offline`, `device.telemetry.*`, `device.command.completed` | `device.command.created` |
| Device Service (registry+twin) | stable, security-sensitive core | low write volume | `devices`, `device_tools`, `device_twin`, groups | `/v1/devices`, `/v1/groups` | `device.registered`, `device.state.changed` | `device.online`, `device.telemetry.updated` |
| Identity Service | security domain isolation, later Keycloak | no SSO/multi-org requirement yet | users, orgs, roles, tokens | `/v1/auth`, OIDC-ish | `identity.*` | — |
| Telemetry Service | highest write rate, own scaling | pipeline does not exist at scale yet; learn real load first | hypertables | `/v1/telemetry` | `device.telemetry.updated` | `device.online` |
| Command Service | needs Redis correlation to scale | volume trivial | `commands`, results | `/v1/commands` | `device.command.*` | `device.online` |
| OTA + Firmware Service | bandwidth-heavy, blob-oriented; merge "Firmware" into OTA (same data) | not built; storage boundary (BlobStore port) is enough | `firmware_images`, `rollouts`, MinIO | `/v1/firmware`, `/v1/rollouts` | `device.ota.*` | `device.online`, `device.state.changed` |
| Automation Service | CPU-bound rule eval at fleet scale | trivial at ≤ 1k devices | `rules`, executions | `/v1/rules` | `automation.triggered` | telemetry, state, alerts |
| Alert Service | fan-out and dedupe logic | rides the same events; small | `alerts`, alert rules | `/v1/alerts` | `device.alert.created` | telemetry, online/offline |
| Agent Service | separate trust boundary for AI traffic | no AI consumer built yet | `agents`, `agent_tools`, policies | `/v1/agents` | `agent.*` | `device.state.changed` |
| MCP Gateway | different transport + a hostile-input boundary | transport spike unresolved (§19) | none | MCP server | `agent.tool.executed` | — |
| Notification Service | naturally decoupled fan-out | low volume | none | internal | — | `device.alert.created` |

### 22. Security Architecture
Three separate models:
* **Users:** local users + short-lived JWT (access) + refresh, RBAC (owner/admin/operator/viewer) plus
  capability-level permissions (`command:<family>:<risk>`). Write the guard against OIDC-style claims
  (`iss`,`sub`,`aud`,`scope`) so Keycloak can replace the issuer by config. **Keycloak: not now**
  (trigger: SSO / multiple customer orgs / enterprise IdP).
* **Devices:** per-device broker credentials + **topic ACLs** (device: publish only its own
  `status`/`response`, subscribe only its own `command`; only the platform identity may publish
  `…/command`). This makes S1/S2 unreachable from the broker side with no firmware change. CloudAMQP
  plan support for per-user topic permissions is **[unverified]** — must be confirmed first; certificates/
  mTLS later. Privileged operations use `platform_exec`: TokenService derives a per-device key
  `HKDF(master_key, device_id)`, so compromise of one device does not expose the fleet; on-device
  allow-list of target tools (firmware) closes S4-a.
* **Services / AI agents:** service accounts with scoped tokens; agents never receive DB or broker access.
* **Secrets:** env now (`.env` never committed); the master key moves to Vault only when per-device
  credential issuance/rotation is automated (**Vault: not now**).
* **Policy enforcement point** shared by REST guards, MCP gateway and automation: subject × action ×
  resource × risk class × constraints (rate, time window, approval). Default-deny for unknown tools.
* **Audit:** append-only `event_log` for every privileged action (who/what/target/decision/result).
* **Hardening list for the existing API** (before any non-localhost exposure): remove `MqttController`,
  validate `baseUrl` against an allow-list/registry (B3), global `ValidationPipe`, throttling, helmet.

### 23. OTA Architecture
```
Upload → Hash → Sign → Compatibility → Deploy(waves) → Progress → Health check → Rollback
```
| Stage | Design | Current constraint |
|---|---|---|
| Upload | stream to S3-compatible `BlobStore` (MinIO), never Postgres | no store yet |
| Hash | SHA-256 at upload; stored | device cannot verify a hash (S5) → firmware: add `sha256` input to `ota_update` |
| Sign | Ed25519 signature over a manifest `{sha256,size,version,target,min_fw,needs_dual_ota}` | device verifies nothing today; long-term secure boot v2 |
| Compatibility | chip target + `ota_status` "update possible" + version rules from registry | dual-OTA layout not on every board |
| Deploy | rollout waves canary → 10% → 50% → 100%, auto-halt at failure threshold; trigger via `platform_exec` → `ota_update(url=presigned HTTPS)` | needs TokenService (platform) + device trusting the URL's TLS chain **[unverified]** |
| Progress | device gives none; infer: `dispatched → rebooting (offline) → verifying` with timeouts | firmware prerequisite for real progress is optional |
| Health check | `online` again + `ota_status.version == target` + telemetry sane within N min | — |
| Rollback | today: re-dispatch previous image (fails if the new image cannot connect) | **firmware:** enable `CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE` + mark valid after MQTT connect |
Tables: `firmware_images`, `rollouts`, `rollout_targets(state machine)`; events `device.ota.*`.

### 24. Edge Gateway Architecture (optional)
Deployable = the Device Gateway module run standalone plus small add-ons: local MQTT broker bridged to
the cloud, a NATS leaf node / persistent queue (store-and-forward), local registry cache, local rules
(same rule IR, §25), mDNS discovery (solves "mDNS does not cross the tailnet" by living on the LAN), secure
tunnel (Tailscale/WireGuard), telemetry aggregation. Devices are pointed at the gateway via their existing
`mqtt_base_topic`/broker config. **Not needed for MVP**; trigger = a site with unreliable uplink,
bandwidth/privacy limits, or > ~100 devices behind one NAT.
**Offline-first rules:** telemetry is append-only with `device_ts + seq` → dedupe key `(device_id, metric,
device_ts, seq)`; server receive time kept separately; devices without SNTP mark `ts_quality=untrusted`.
Commands carry `idempotency_key` and `expires_at` (a queued command must not run hours late). Twin uses
versions (§18). Edge-originated actions are logged with `origin=edge` and synced as events. **ESP-Claw
has no telemetry store-and-forward today** — new firmware or gateway work.

### 25. AI Agent Architecture
`User → Central Agent → MCP Gateway → PEP → Command module → Device Gateway → ESP-Claw tool`.
* Tool risk class derived from flags: `read` (status/list), `write` (actuate/config), `critical`
  (root-only, OTA, network, credential) → `critical` requires human approval or a signed `platform_exec`.
* Budgets/rate limits per agent, kill switch, full `agent.tool.executed` audit, no direct DB.
* Agent-to-agent: fleet → group agents via internal task events; no shared memory. Platform-side vector
  memory: **not now**.
* **Rules engine / edge-cloud continuum:** one rule IR (conditions: threshold, AND/OR, time, schedule,
  device state, event; actions: command, set desired, notify, run agent) with a `placement` attribute
  (`cloud | gateway | device`). Device placement compiles to `claw_event_router` JSON pushed with the
  already-reachable `add_router_rule` (note S1: that tool must itself become policy-gated). Feasibility of
  the IR → router-schema mapping must be checked against the router's rule schema **[unverified]**.
  Placement guidance: hard-real-time actuation → device; per-site aggregation/caching → gateway;
  cross-device logic, LLM analysis, history → cloud; privacy-sensitive inference → local server.
* Scalability: 10 → current design; 100 → dedicated probe instead of command-polling, retention;
  1 000 → push telemetry, batching, Timescale compression/aggregates, Redis if 2 replicas; 10 000 →
  replicas + MQTT5 shared subscriptions or broker→NATS, split ingest; 100 000+ → dedicated broker
  cluster (self-hosted becomes justified), extracted ingest, K8s. Ballpark reasoning, not benchmarks.

---

## PART C — DECISIONS

### 26. Open decisions (need your answer before any implementation)
1. **Firmware hardening (S1–S3, S4-a, S5):** fix in `esp-claw-2` first (gate `lua_run_script`,
   `write_file`, `add_router_rule`, `scheduler_add`, `http_request`, `register_skill` behind an allow-list
   for the MQTT/MCP bridges; MCP off or authenticated by default; `platform_exec` target allow-list;
   `sha256` for OTA; rollback), or accept the risk short-term and rely on broker ACLs?
2. **CloudAMQP:** does the plan support per-user topic permissions? (decides whether §22 is config-only.)
3. **Stage 0 (stabilize) authorization:** OK to fix B1–B4, B7, B8, B12 on the current code before any
   evolution work?
4. **MCP transport spike:** OK to timebox a spike proving a standard MCP client can talk to `esp_mcp`?

### 27. Technology decision matrix
| Technology | Problem solved | Current need | Complexity | Resource cost | Security impact | Scalability impact | Alternative | Decision |
|---|---|---|---|---|---|---|---|---|
| TypeScript/NestJS | modular monolith, DI, modules | yes | Low | Low | neutral | good ≤ 10k devices/instance | Fastify+own DI | **KEEP** |
| Go | high-throughput ingest/gateway | no | Med (2nd stack) | Low | neutral | high | Node workers | **NOT NEEDED** (revisit for Edge Gateway binary) |
| PostgreSQL | relational control/data | yes | Low | Low | RBAC, RLS option | vertical, then partition | — | **KEEP** |
| TimescaleDB | time-series, retention, aggregates | first hypertable exists | Low | Low | neutral | high | plain PG partitions, ClickHouse | **KEEP** (+ add retention/compression) |
| Redis | cache, sessions, locks, rate limit, correlation | no (1 instance) | Low | Low | secret store risk if misused | enables >1 replica | in-memory, Postgres | **ADD LATER** (2nd replica or WS fan-out) |
| NATS JetStream | durable events, edge store-and-forward | in-process suffices | Med | Low | needs authn/authz config | high, leaf nodes | Redis Streams, Postgres outbox | **ADD LATER** (§20 triggers); **ADD NOW** the `EventBus` port + outbox |
| MinIO | firmware/image blobs | at OTA stage | Low | Med (disk) | bucket policies | good | cloud S3 | **ADD LATER** (Stage 4) behind `BlobStore` |
| OpenTelemetry | traces/metrics/logs API | context only | Med | Low | data leakage in spans | needed at scale | pino + Prom only | **ADD NOW** (context/SDK, no collector) |
| Prometheus | metrics | `/metrics` endpoint | Low | Low | low | high | OTel metrics | **ADD NOW** endpoint; server **ADD LATER** |
| Grafana | dashboards | no | Low | Med | needs authn | — | built-in UI | **ADD LATER** |
| Loki | log aggregation | Docker logs suffice | Med | Med | log PII | high | files/journald | **NOT NEEDED** yet |
| Tempo | distributed traces | not distributed yet | Med | Med | span data | high | Jaeger | **ADD LATER** |
| Keycloak | SSO/OIDC/multi-org | no | High | Med-High | strong | good | own JWT | **NOT NEEDED** now |
| Vault | secret issuance/rotation | env vars OK | High | Med | strong | — | env + SOPS | **NOT NEEDED** now |
| K3s | edge orchestration | no | Med | Low | — | edge | Compose | **NOT NEEDED** (edge ≥ 3 services) |
| Kubernetes | large-scale orchestration | no | High | High | — | high | Compose on VMs | **NOT NEEDED** (≥ 10k devices / HA needs) |
| Tailscale | device reachability, secure tunnel | in use | Low | Low | strong | good | WireGuard direct | **KEEP** |
| WireGuard | on-device VPN option | on-device already | Low | Low | strong | good | Tailscale | **KEEP** (device-side) |
| MCP | tool protocol for agents | facade planned | Med | Low | new attack surface | good | direct REST tools | **KEEP** device-side; gateway **ADD LATER** |
| WebSocket | live dashboard | no frontend yet | Low | Low | authn per socket | needs fan-out at scale | SSE | **ADD LATER** (with dashboard) |
| REST + OpenAPI | primary API | yes | Low | Low | validation | good | GraphQL | **KEEP** + **ADD NOW** OpenAPI/versioning/validation |
| CloudAMQP (broker) | device transport | in use | none | external | shared creds today | plan-limited | EMQX/Mosquitto | **KEEP** (self-host only at 10k+) |

### 28. Decision table (KEEP / ADD NOW / ADD LATER / REPLACE / NOT NEEDED)
| Bucket | Items |
|---|---|
| **KEEP** | NestJS + TypeScript, pnpm monorepo, PostgreSQL, TimescaleDB, TypeORM with explicit migrations, zod, `@esp-claw/protocol` package, Vitest, Docker Compose, Tailscale, on-device WireGuard, CloudAMQP, REST, existing `device.status` event pattern |
| **ADD NOW** | Fixes B1–B4/B7/B8; global `ValidationPipe` + DTO classes; API versioning `/v1` + OpenAPI; pagination/filter/sort; consistent error envelope; JWT auth + RBAC + org_id (nullable → backfilled); `EventBus` port + envelope + outbox + append-only `event_log`; module boundaries (public `index.ts`, lint rule, module-owned entities/migrations); `/health/live`+`/ready`, `/metrics`, JSON logs with correlation id; pinned DB image + backend Dockerfile; migration as a separate job; `{prefix}/#` subscription; device-facing broker creds + ACL (pending §26-2); `device_twin` + `device_tools`; alerts on offline; TokenService for `platform_exec` |
| **ADD LATER** | Redis (2nd replica / WS fan-out); NATS JetStream (triggers §20); MinIO + OTA module; WebSocket (with dashboard); Prometheus server/Grafana/Tempo; MCP Gateway (after transport spike); Edge Gateway; push telemetry (firmware); Timescale compression/continuous aggregates; schema-per-module split; first service extraction (telemetry ingest) |
| **REPLACE** | Direct `EventEmitter2` use → `EventBus` port (EE2 stays as adapter); central entity registry → module-owned entities; telemetry-through-`commands` → dedicated probe path (no `commands` rows, `origin` column); in-memory correlation map → Redis (only when >1 instance); unqualified metric names → `source.metric`; `latest-pg16` → pinned tag; `mqtt/*` debug controller → removed; `#` subscription → prefix subscription |
| **NOT NEEDED (now)** | Go, Kubernetes, K3s, Keycloak, Vault, Loki, microservices, self-hosted broker, eBPF, GraphQL, platform-side vector memory, full event sourcing |

### 29. Migration strategy and proposed sequence (NOT started)
Every stage: Audit → Design → Migration → Backward compatibility → Implementation → Tests → Docs; no
destructive migration without a written rollback.
* **Stage 0 — Stabilize — DONE 2026-09-20, see [STAGE0-STABILIZATION.md](STAGE0-STABILIZATION.md)** (no schema change): B1 (single command id), B2–B4 guards/removals, B7 reaper,
  B8 shutdown hooks, B12; add tests for commands/devices/poller. *Rollback: git revert; no schema change
  except `commands` (additive).*
* **Stage 1 — Boundaries + events:** module public APIs + lint rule, `EventBus` + envelope + outbox, `/v1`,
  validation, OpenAPI, observability basics. *Additive migrations only.*
* **Stage 2 — Identity + registry:** users/orgs/RBAC, `org_id` nullable → backfill to a default org →
  `NOT NULL`, `device_tools`, per-device credentials/ACL. *Backfill is reversible (column drop).*
* **Stage 3 — Data plane v2:** `device_twin`, alerts, telemetry v2 (dedicated probe, retention).
* **Stage 4 — Firmware/OTA + MinIO + TokenService** (needs the firmware hardening from §26-1).
* **Stage 5 — Agents / MCP Gateway / policy engine / automation IR.**
* **Stage 6 — Scale features on trigger:** Redis, NATS, Edge Gateway, Prometheus/Grafana/Tempo.

Firmware work items (separate repo, tracked here as prerequisites): allow-listed bridges (S1–S3),
`platform_exec` allow-list + larger token budget (S4), `ota_update` `sha256` + rollback (S5),
`claw_describe`, optional `mcp_url`/schema hash in status, MCP disabled-or-authenticated default.
