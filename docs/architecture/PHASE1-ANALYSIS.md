# ESP-Claw IoT Management Platform — Phase 1: Architecture Analysis

Status: **DESIGN ONLY** — no implementation code in this phase, per the project's own process (ANALYZE → DESIGN → IMPLEMENT → TEST → VERIFY → DOCUMENT).

---

## 0. Ground Truth Correction — What ESP-Claw Actually Does Today

Rule #38 in the brief is explicit: don't invent ESP-Claw facts. I have first-hand, hands-on knowledge of the real `esp-claw-2` firmware (I built and shipped its MQTT subsystem, capability model wiring, config schema, VPN, and OTA this session, on real hardware — an ESP32-S3 N16R8). Several assumptions in the original prompt don't match the real firmware. Correcting them now avoids designing a platform against an imaginary device.

| Prompt assumed | Reality in ESP-Claw today |
|---|---|
| `espclaw/{tenant_id}/{device_id}/telemetry\|state\|events\|commands\|responses\|config\|status\|logs\|ota` — 9 topic leaves | Only **3 leaves exist**: `status` (retained presence + LWT), `command` (inbound), `response` (outbound). No `telemetry`, `events`, `state`, `logs`, `config`, or `ota` MQTT leaves exist in firmware. |
| MQTT 5 "where appropriate" | The device speaks **MQTT 3.1.1** today (ESP-IDF's `esp-mqtt` protocol version was never set to v5). MQTT5 is reachable (ESP-IDF supports it) but is a real firmware change, not a platform-side setting. |
| Device self-reports `capabilities: {sensors: [...], actuators: [...], camera: bool, ...}` | ESP-Claw's real introspection primitive is a **generic tool/capability catalog** (`claw_cap_descriptor_t`: id, family, description, `kind` [CALLABLE/EVENT_SOURCE/HYBRID], `cap_flags` [CALLABLE_BY_LLM/RESTRICTED/ROOT_AGENT_ONLY/...], and a **JSON-Schema** per tool), grouped (`cap_mqtt`, `cap_web_search`, `cap_vpn`, `cap_ota`, `cap_system`, …), already exposed today over local HTTP as `GET /api/capabilities`. There is no fixed `sensors[]`/`actuators[]` taxonomy — sensor/actuator access is wired per board through Lua modules and board YAML (`board_peripherals.yaml`), not a uniform runtime-declared list. |
| Device has a REST/telemetry API the platform can call directly | The on-device HTTP API (`/api/status`, `/api/config`, `/api/capabilities`, `/api/webim/*`, `/api/restart`) is **plain HTTP, LAN-only, with no authentication**. It's a local provisioning/debug surface, never meant to be reachable from the public internet. All ongoing platform↔device traffic must go over MQTT (which does have TLS + username/password). |
| Command/response is something to invent | It already exists and works, tested live this session against a real broker (CloudAMQP): inbound JSON on `command` → either `{"action":"capability","name":"<cap>","input":{...}}` (direct capability call) or free text → routed through the full agent/LLM pipeline; reply published to `response`. Correlation today is an **application-level `id` field inside the JSON payload**, not MQTT5 Correlation Data. |
| `mqtt_configure`/`ota_update`/`vpn_configure`/etc. are freely reachable | These are `CLAW_CAP_FLAG_RESTRICTED \| CLAW_CAP_FLAG_ROOT_AGENT_ONLY`. Critically — I found and fixed a real vulnerability this session where the MQTT command bridge ran capability calls with a caller identity that **bypassed** this restriction entirely. After the fix, restricted tools are **unreachable via the raw `command` topic** — they only work through the real agent/LLM conversational path (Telegram/local WebIM today). This is a first-order constraint on how the platform can do bulk OTA/config (see §C and §H). |
| OTA is "ready" | `ota_update` exists, is HTTPS-only (I enforced this after finding it accepted plain `http://` with zero image-signing), requires a dual-OTA partition table (not all boards are flashed with one yet), and has **no automatic rollback** configured (no `CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE`, no `esp_ota_mark_app_valid_cancel_rollback()`). A bad image will not self-heal today. |
| Secrets are safe in `/api/config` | They are not masked. `GET /api/config` returns `mqtt_password`, `wg_private_key`, LLM `api_key`, etc. in plaintext today. The platform must never mirror this endpoint's raw output anywhere, and should treat it as a reason to push secrets down, never pull them up. |
| Device identity | `device_id` = lower-case hex of the base MAC (`esp_read_mac`, 12 hex chars, e.g. `ecda3b4ff7d4`). Stable, globally unique, free (no provisioning step needed to mint it). |

One genuinely good finding: **tenant-scoped topics need zero firmware changes.** The firmware builds every topic as `"{base_topic}/{device_id}/{leaf}"`, and `base_topic` is already a free-text config field (`mqtt_base_topic`, default `"espclaw"`). Setting it to `"espclaw/acme-farms"` per-tenant at provisioning time gives you `espclaw/acme-farms/{device_id}/status` etc. today, with no ESP-Claw code changes — exactly the "use the existing capability, don't invent an API" instruction in item 8.

Where the prompt wants something that doesn't exist (`telemetry`, `events`, `logs` MQTT leaves; MQTT5; OTA rollback; a non-chatty admin command path), §C, §E and §H below propose it explicitly as a **new ESP-Claw capability/extension**, not as an assumed existing feature.

---

## A. Understanding of the Project

You want a **central fleet-management plane** for a heterogeneous population of ESP32(-S3/-C3/-C6/-H2) devices, each running the same firmware family (ESP-Claw) but configured completely differently per physical role (agriculture node, energy monitor, camera, home automation, industrial node...). Every device is simultaneously:

1. **A managed IoT endpoint** — identity, network/MQTT/OTA config, health, telemetry, alerts.
2. **An autonomous edge AI agent** — has its own LLM backend, tools/skills, and can act independently (including offline) via ESP-Claw's own agent core.

The platform's job is *not* to replace ESP-Claw's on-device intelligence, but to give you **one pane of glass** across many independent agents: discover them, group them, watch them, command them (individually or in bulk), push firmware, enforce security boundaries, and — crucially — manage the *agent* dimension (models/providers/secrets) safely, since that is genuinely new territory ESP-Claw's local Web UI doesn't do today.

Non-negotiables I'm designing to: single-tenant now with multi-tenant data model from day one (§ item 18); MQTT as the device-facing backbone, never REST-to-device; real ESP-Claw capabilities as the integration surface, adapters for the gaps; secrets never in the frontend, never in MQTT payloads in the clear where avoidable, never in source; start small (Docker Compose, 1–~50 devices) with an explicit, honest scale-out path rather than premature distributed-systems machinery.

---

## B. Architecture Proposal

```
                                   ┌───────────────────────────┐
                                   │        Web Dashboard        │
                                   │   (Next.js / React, TS)     │
                                   └──────────────┬───────────────┘
                                    REST (OpenAPI) │ WebSocket
                                   ┌──────────────▼───────────────┐
                                   │         API Gateway           │
                                   │  (NestJS: auth, rate-limit,   │
                                   │   OpenAPI, WS Gateway)        │
                                   └───┬─────────┬─────────┬──────┘
                    ┌───────────────────┘         │         └───────────────────┐
           ┌────────▼────────┐          ┌─────────▼─────────┐         ┌─────────▼─────────┐
           │ Device Registry  │          │  Command Service   │         │  OTA Service       │
           │  Service         │          │  (req/reply over    │         │ (rollout, groups,  │
           │ (identity, groups,│          │   MQTT, correlation)│         │  progress, signing)│
           │  capabilities)   │          └─────────┬─────────┘         └─────────┬─────────┘
           └────────┬────────┘                    │                             │
                    │            ┌──────────────────▼──────────────────┐         │
                    │            │        Telemetry / Ingest Service    │◄────────┘
                    │            │  (MQTT subscriber → Timescale batch, │
                    │            │   presence/LWT tracking, event bus)  │
                    │            └──────────────────┬──────────────────┘
                    │                                │
                    │                     ┌──────────▼──────────┐
                    │                     │   Redis (pub/sub,    │
                    │                     │   correlation TTL,   │
                    │                     │   BullMQ job queues) │
                    │                     └──────────┬──────────┘
                    │                                │  fan-out to WS Gateway replicas
           ┌────────▼────────────────────────────────▼────────┐
           │              PostgreSQL + TimescaleDB              │
           │  relational: users/orgs/devices/groups/rules/...   │
           │  hypertables: telemetry, events, logs, audit_logs  │
           └─────────────────────────────────────────────────────┘

                                   ┌───────────────────────────┐
                                   │      Automation Engine      │
                                   │  (rule eval, subscribes to  │
                                   │   telemetry+events, issues  │
                                   │   commands via Command Svc) │
                                   └───────────────────────────┘

                                   ┌───────────────────────────┐
                                   │  AI Agent Mgmt Service      │
                                   │  (per-device agent config,  │
                                   │   provider secrets vault,   │
                                   │   pushed via Command Svc —  │
                                   │   never pulled from device) │
                                   └───────────────────────────┘

                                        MQTT (TLS, 3.1.1 today)
                                   ┌───────────────────────────┐
                                   │        MQTT Broker          │
                                   │   (EMQX — see §F)           │
                                   └──────────────┬───────────────┘
                     ┌───────────────────┬────────┴────────┬───────────────────┐
              ESP32-S3 #1          ESP32-S3 #2       ESP32-C3 #3         ESP32-S3-CAM #N
              ESP-Claw             ESP-Claw          ESP-Claw            ESP-Claw
           (agriculture)          (energy)          (home)              (camera)
```

Key architectural decisions embedded above:

- **All services are logical modules inside one NestJS app at MVP**, not separate deployables — see §H. The diagram shows the *eventual* microservice boundary so extraction later is a refactor, not a rewrite. This directly answers item 32's "where are the bottlenecks" question: at MVP scale (tens to low-hundreds of devices) a monolith-with-clean-modules outperforms a distributed system operationally; the first thing to actually extract under real load is the **Telemetry/Ingest Service** (highest message rate, independent scaling need), then the **WS Gateway** (needs horizontal replicas behind Redis pub/sub before anything else does).
- **Command Service is the only thing allowed to publish to a device's `command` topic.** No other service touches MQTT publish for commands directly — this keeps authorization, correlation-id bookkeeping, and timeout/retry logic in one place (item 7, item 33).
- **The Automation Engine and AI Agent Mgmt Service never talk to MQTT directly either** — they go through Command Service. This is the item-15 requirement ("Automation Engine independent of the ESP32, running in cloud/server") satisfied without a second MQTT client sprawl.
- **Telemetry/Ingest Service is the only MQTT subscriber for data-plane topics** (`status`, and the *new* `telemetry`/`events` leaves once built — see §C). It writes to TimescaleDB and republishes normalized events to Redis for the WS Gateway.

### The ESP-Claw Integration/Adapter Layer (item 8)

Per item 8's own instruction, gaps are bridged with an **adapter**, not an invented device API:

```
Platform Command Service
        │
        │  { "id": "...", "action": "capability", "name": "<real cap>", "input": {...} }
        ▼
   MQTT `command` topic  →  ESP-Claw cap_mqtt bridge  →  claw_cap_call() (SUB_AGENT auth)
        │
        ▼
   Real registered capability (get_system_info, mqtt_status, web_search, vpn_status, ...)
```

For capabilities that need to be **RESTRICTED/ROOT_AGENT_ONLY** (mqtt_configure, vpn_configure, wireguard_configure, ota_update, and any future `wifi_configure`) — which the bridge deliberately cannot reach after this session's security fix — the adapter has two legitimate paths, and I recommend building **both**, for different reasons:

1. **Conversational path (works today, zero firmware changes):** Command Service sends a directed natural-language instruction on the `mqtt`-bound channel (same mechanism Telegram uses) and parses the agent's reply. Good for one-off admin actions on a single device. **Not suitable for bulk/reliable orchestration** — I observed the LLM occasionally produce garbled output instead of a tool call during this session's own testing. Never build OTA rollout automation on top of this path.
2. **New capability group, `cap_platform` (proposed ESP-Claw extension, Phase 6):** a small set of capabilities flagged `CALLABLE_BY_LLM` (so the *existing* `SUB_AGENT`-authorized MQTT bridge can reach them directly, deterministically, no LLM round-trip) but individually protected by a **platform-issued, short-lived HMAC-signed command token** verified on-device (a new, narrow trust mechanism — not a blanket bypass of `ROOT_AGENT_ONLY`). This is the right home for platform-triggered OTA, bulk config push, and remote restart. This is new ESP-Claw firmware work and is called out explicitly as such in the roadmap (§I) — not assumed to exist.

---

## C. MQTT Architecture

### Topic namespace (extends the real, working scheme — doesn't replace it)

```
{base_topic}/{device_id}/status         existing — retained presence + LWT
{base_topic}/{device_id}/command        existing — inbound, subscribed by device
{base_topic}/{device_id}/response       existing — outbound replies

{base_topic}/{device_id}/telemetry      NEW — periodic sensor/state push (cap_telemetry, Phase 6)
{base_topic}/{device_id}/event          NEW — discrete occurrences (button press, threshold cross, boot)
{base_topic}/{device_id}/ota/progress   NEW — OTA download/verify/reboot progress (cap_ota extension)
```

`base_topic` already gives free tenant scoping today (`espclaw/{tenant_slug}`), so the platform subscribes with `espclaw/+/+/status`, `espclaw/+/+/telemetry`, etc., and reads `tenant_slug` and `device_id` out of the topic segments — no payload duplication needed for routing.

### QoS / Retain / LWT (as implemented today, extended consistently)

| Leaf | Direction | QoS | Retain | Notes |
|---|---|---|---|---|
| `status` | device → broker | 1 | **yes** | Birth `{"online":true}` on connect; **LWT** `{"online":false}` set at connect time, fires on ungraceful disconnect. This is the platform's presence source of truth — subscribe once, get instant "was it already offline" on subscribe (retained) plus live transitions. |
| `command` | platform → device | 0 or 1 (platform's choice per command) | no | Device auto-subscribes on connect. |
| `response` | device → platform | 1 | no | |
| `telemetry` (new) | device → broker | 0 (lossy sensor data is fine) | no | High volume; QoS0 keeps broker/device load down. Batch multiple readings per publish where the sensor task allows. |
| `event` (new) | device → broker | 1 | no | Discrete, must not be silently dropped. |
| `ota/progress` (new) | device → broker | 1 | **yes**, last value | So a dashboard opened mid-rollout sees current progress immediately. |

QoS2 is **not** currently exposed by ESP-Claw's `cap_mqtt` tools (capped at 0/1 in the tool's JSON-Schema even though the underlying `esp-mqtt` library likely supports it) — treat QoS2 as unavailable until that's deliberately extended; nothing in this platform design needs it.

### MQTT 5 vs 3.1.1

The device is 3.1.1 today. Recommendation: **design the platform's MQTT client and broker for MQTT5, but do not depend on any v5-only feature for correctness.**
- Use the **application-level `id`/`correlation_id` JSON field** for request/response correlation (already how the firmware works) instead of MQTT5 Correlation Data — keeps the protocol 3.1.1-compatible and broker-agnostic.
- Adding real MQTT5 to ESP-Claw later (`protocol_ver = MQTT_PROTOCOL_V_5` in `esp_mqtt_client_config_t`, actually available in ESP-IDF's `esp-mqtt`) is a nice-to-have for Session/Message Expiry and User Properties, not a blocker for anything in this platform's MVP or V1.

### Command/Response protocol (extends the real, tested envelope)

**Command (platform → `command`):**
```json
{
  "id": "cmd-9f3a1e2b",
  "action": "capability",
  "name": "relay_set",
  "input": { "relay": 1, "state": true },
  "issued_at": "2026-09-15T19:00:00Z",
  "timeout_ms": 15000
}
```
(`issued_at`/`timeout_ms` are platform-side additions the device simply ignores today — additive, non-breaking.)

**Response (device → `response`, real shape already emitted):**
```json
{ "id": "cmd-9f3a1e2b", "capability": "relay_set", "ok": true, "result": "..." }
```

**Command Service state machine** (new, platform-side — item 7's ACK/timeout/retry):
```
PENDING → (published to broker) → SENT
   SENT → (response with matching id within timeout_ms) → SUCCEEDED | FAILED (per "ok")
   SENT → (no response before timeout_ms) → TIMED_OUT → retry (bounded, backoff) or DEAD
```
Correlation state lives in **Redis** (`cmd:{id}` → device_id, issued_at, timeout, retry_count; TTL = timeout + grace), not Postgres — it's inherently short-lived and this avoids write amplification on the primary DB for every command round-trip. Once resolved, a row is written to the `commands`/`command_results` tables (§D) for history/audit.

Unauthorized/rejected: if `name` refers to a capability the device denies (RESTRICTED/ROOT_AGENT_ONLY, or `cap_flags` missing `CALLABLE_BY_LLM`), the real `cap_mqtt` bridge already responds with `ok:false` and an explanatory `result` string (verified live this session: `"Denied agent cap call ... reason=root_agent_only"` appears in the device log; the bridge still publishes a normal response envelope) — Command Service maps that to `status: "rejected"`, not `"failed"`, so operators can tell "device refused" apart from "device errored."

---

## D. Database Architecture

Single engine: **PostgreSQL + TimescaleDB extension** (see §F for why, not a separate InfluxDB). Logical grouping, not literal DDL:

**Relational (regular Postgres tables):**
```
organizations(id, name, plan, created_at)
users(id, org_id FK, email, password_hash, role, created_at)
api_keys(id, org_id FK, user_id FK, key_hash, scopes[], last_used_at, expires_at)

projects(id, org_id FK, name)                    -- "Farm 1", "Factory" (item 18/19's grouping level)
device_groups(id, project_id FK, name)            -- "Greenhouse", "Energy Monitoring"
device_group_members(group_id FK, device_id FK)   -- many-to-many

devices(
  id (= device_id, e.g. ecda3b4ff7d4, PK),
  org_id FK, project_id FK,
  device_name, device_type, device_model, chip,
  mac_address, firmware_version, esp_claw_version, hardware_revision,
  mqtt_base_topic,                     -- tenant-scoped topic prefix actually in use
  status (enum: online/offline/warning/critical/provisioning/decommissioned),
  last_seen_at, ip_address,
  created_at, updated_at
)
device_capabilities(device_id FK, group_id, cap_id, cap_flags, input_schema_json, discovered_at)
                                       -- mirrors the REAL claw_cap catalog, pulled via
                                       -- {"action":"capability","name":"get_system_info"}-style
                                       -- introspection commands, refreshed on reconnect
device_credentials(device_id FK, kind [mqtt_password|wg_private_key|api_key], secret_ref)
                                       -- secret_ref points into the secret vault (§G), never the
                                       -- plaintext value itself, in line with §0's masking finding

agents(device_id FK PK, agent_name, system_prompt, model_provider, model_name,
       provider_secret_ref, permissions_json)   -- §item 9; secret_ref only, never a raw key

commands(id PK, device_id FK, issued_by_user_id FK, action, name, input_json,
         status, timeout_ms, created_at, resolved_at)
command_results(command_id FK PK, ok, result_json, received_at)

automation_rules(id, project_id FK, name, condition_json, action_json, enabled, edge_capable bool)
firmware(id, esp_claw_version, board_target, sha256, size_bytes, storage_url, signed bool, created_at)
ota_jobs(id, firmware_id FK, target: device_id | group_id, strategy [canary%|all],
         status, started_at, finished_at)
ota_job_devices(job_id FK, device_id FK, status, progress_pct, error, updated_at)

alerts(id, project_id FK, rule_id FK nullable, device_id FK, severity, message, acked_at, created_at)
audit_logs(id, org_id FK, user_id FK, action, target, ip, created_at)  -- also a hypertable, see below
```

**Hypertables (TimescaleDB, high-volume/append-only):**
```
telemetry(time, device_id FK, metric, value_numeric, value_text, value_bool)
events(time, device_id FK, event_type, payload_json)
device_logs(time, device_id FK, level, message)         -- from ESP-Claw
platform_logs(time, service, level, message)             -- backend/broker/DB/OTA/auth
audit_logs(time, org_id, user_id, action, target)         -- append-only, compressed after 90d
```

Retention policy (item 28): continuous aggregates for `telemetry` at 1m/1h/1d rollups (satisfies item 13's 24h/7d/30d/1y graphs cheaply); raw telemetry compressed after 7 days, dropped after 90 days by default (configurable per org/plan); `events`/`device_logs` compressed after 30 days, dropped after 1 year; `audit_logs` never auto-dropped (compliance).

Indexes: `devices(org_id, project_id, status)`, `devices(last_seen_at)` for offline-detection sweeps, `telemetry` hypertable's native `(device_id, time DESC)` chunk index, `commands(device_id, status, created_at)` for the timeout-sweeper job.

---

## E. Device Lifecycle

```
Provisioning → Registration → Authentication → Online ⇄ Offline → Firmware Update → Decommission
```

1. **Provisioning** (item 20) — happens on the LAN, using ESP-Claw's *real, existing* mechanisms, not invented ones: device boots into AP-fallback mode (`ESP-Claw-XXXX`, `192.168.4.1`, already implemented in `wifi_manager`), the installer/technician connects, uses the on-device local HTTP API (or the on-device Setup Wizard page) to set Wi-Fi + `mqtt_broker`/`mqtt_username`/`mqtt_password`/`mqtt_base_topic` (set to the tenant's assigned prefix here). This step is inherently local/physical-presence — the platform's role is to *hand the technician* the right values (tenant's broker host, a freshly-minted per-device MQTT credential, the tenant topic prefix), not to reach the device itself yet.
2. **Registration** — first time the platform's Telemetry/Ingest Service sees a retained `status` birth message (or a `command`/`response` round-trip) for a `device_id` it doesn't recognize under that tenant's broker credentials, it auto-creates a `devices` row (`status = provisioning`) and immediately issues an introspection command (`get_system_info`, then a capability-catalog pull) to populate `device_capabilities`. This satisfies item 21 ("Device Discovery") using the real introspection primitive, not an invented one.
3. **Authentication** — device-to-broker: MQTT username/password today (already real), per-device unique credentials issued at provisioning (not one shared broker password for the fleet — this is a hard requirement I'm adding, see §G); TLS is mandatory for anything beyond localhost testing (device already supports `mqtt_tls_enabled`). User-to-platform: standard JWT session + refresh token; service-to-service inside the backend: none needed at MVP (same process).
4. **Online/Offline** — driven entirely by the retained `status` + LWT mechanism already built; the platform never polls. A device transitions to `offline` in the UI the instant the broker delivers the LWT (or, defensively, if no `status`/heartbeat has been seen for `N` × keepalive as a backstop for brokers that delay LWT delivery).
5. **Update** — see OTA in §H/roadmap; state tracked in `ota_job_devices`.
6. **Decommission** — soft-delete (`status = decommissioned`, retain historical telemetry per retention policy), revoke that device's MQTT credential at the broker (ACL/user removal), do **not** hard-delete rows that audit/history depends on.

---

## F. Technology Stack — decisions, with justification

Your existing environment (item 39) already answers several of these; I'm not re-litigating what you've already chosen, only what's genuinely open.

| Layer | Choice | Why (and what I rejected) |
|---|---|---|
| MQTT Broker | **EMQX** (open-source core) | Full MQTT5 + 3.1.1, native clustering, built-in dashboard + REST Management API (useful for automating per-device ACLs at provisioning time), Prometheus exporter out of the box, rule-engine can shortcut simple bridge-to-webhook needs later. Mosquitto is lighter but has no clustering/management-API story at the scale this system aims for; VerneMQ is capable but smaller ecosystem; HiveMQ's clustering is paid-only. |
| Backend | **Node.js + TypeScript, NestJS** | Async/event-loop fits MQTT-ingest + WebSocket fan-out naturally; NestJS gives structured modules/DI/guards that map directly onto the microservice boundaries in §B without paying microservice deployment cost yet; shares types with the frontend via a monorepo package. Go would win on raw throughput at 100k+ devices (noted as a later extraction target for just the ingest hot path — not needed now); Python/FastAPI is excellent for AI-heavy work but the platform's AI role is secrets/config management, not inference (inference runs on-device), so Node's MQTT/WS maturity outweighs Python's AI-library edge here. |
| Frontend | **Next.js (React) + TypeScript** | SSR for a snappy dashboard, huge component/chart ecosystem, shares types with NestJS backend. |
| Realtime | **WebSocket** (not SSE) | Genuinely bidirectional need (dashboard issues commands and awaits ACK, subscribes/unsubscribes to per-device telemetry streams) — SSE is one-directional and a poor fit once you have more than a handful of concurrent live subscriptions per client. |
| Primary DB | **PostgreSQL + TimescaleDB extension** | Already in your stack; one engine for relational + time-series avoids cross-database joins for device metadata ↔ telemetry; hypertables/continuous-aggregates/compression directly satisfy items 13 and 28. A dedicated InfluxDB is faster at extreme raw ingest but forces app-level joins back to device metadata — not justified below very large device counts (explicit non-MVP concern per item 40). |
| Cache/Queue | **Redis** (already in your stack) | Pub/sub for WS fan-out across replicas, command correlation TTL store, BullMQ for OTA-rollout/bulk-command job orchestration. Not introducing NATS/RabbitMQ as a third messaging system at MVP — flagged as a legitimate V2/Enterprise addition only if internal service-to-service messaging outgrows Redis pub/sub. |
| Containerization | **Docker Compose** now, Kubernetes-ready later | Matches item 25/40 exactly — every service already runs as a container; moving to k8s later is a manifest-writing exercise, not a redesign. |

---

## G. Security Model

- **Device ↔ Broker:** MQTT over TLS, unique username/password per device (never shared), broker ACL restricting each device to publish/subscribe only under its own `{base_topic}/{device_id}/*` — this is enforceable in EMQX today via its ACL rules keyed on the connecting username, closing off the "one leaked device credential = read/write the whole fleet" risk. mTLS with per-device client certs is the natural V1→V2 upgrade (device already has a stable identity — the MAC-derived `device_id` — usable as the cert CN) but username/password is an acceptable, real MVP given it already works on real hardware today.
- **User ↔ Platform:** JWT access token (short-lived) + refresh token (httpOnly cookie), RBAC (`owner/admin/operator/viewer` roles) enforced at the NestJS guard level, scoped by `org_id` on every query (multi-tenant isolation, item 18) — never trust a client-supplied `org_id`; derive it from the authenticated session.
- **Service-to-service:** none needed while it's one deployable (MVP); when split, mTLS or a shared-secret header behind an internal network only.
- **Secrets (item 9 + the §0 finding):** a dedicated **secret vault table/service** (encrypted at rest with a KMS-managed key, e.g. `pgcrypto` at MVP, a real KMS/Vault later), storing MQTT broker passwords, WireGuard private keys, and — critically — **LLM provider API keys**. The rule from §0 stands: the platform **pushes** secrets down to a device (via the `cap_platform` signed-command path in §B, once built) and **never reads them back**. `device_credentials`/`agents` tables store only opaque `secret_ref` pointers, never plaintext, and API/UI responses must redact any field matching a secret-shaped key name as defense-in-depth even if a bug tries to leak one.
- **OTA integrity:** SHA256 stored per firmware image (`firmware.sha256`), HTTPS-only delivery (already enforced on-device this session), and a code-signing story for the images themselves is a named V1 gap (device has no image-signature verification yet — TLS is the only integrity check today) — tracked explicitly in the roadmap, not silently assumed solved.
- **API keys for machine access** (item 17/26): per-org, scoped, hashed at rest (`api_keys.key_hash`), revocable, never returned again after creation.

---

## H. MVP Definition

The smallest version that is **actually useful and actually true to what ESP-Claw does today**, deliberately excluding anything that needs new firmware:

1. Docker Compose: EMQX, Postgres+TimescaleDB, Redis, NestJS backend, Next.js frontend, Nginx.
2. Device registry: manual "add device" (device_id + tenant topic prefix) *or* auto-registration from first retained `status` birth message.
3. Live presence (online/offline) from the real `status`/LWT mechanism — no polling.
4. Command Service: send any `CALLABLE_BY_LLM` capability call (e.g. `get_system_info`, `mqtt_status`, `web_search`, `vpn_status`) to one device, see the real response, with timeout/retry — using the **existing** command/response envelope, zero firmware changes.
5. Capability catalog pull + display per device (real introspection, item 21).
6. Basic dashboard: fleet summary tiles (item 10), device table, device detail page showing what's *actually* knowable today (status, last_seen, capability list, raw command console) rather than fabricated sensor widgets.
7. Auth: single-org, JWT login, one admin user seeded at first boot.
8. Groups: create a group, send the same command to every member (bulk = fan-out over the same Command Service path, sequential correlation IDs).

Explicitly **out of MVP** (needs real firmware work first, called out honestly rather than faked): telemetry graphs (needs `cap_telemetry`), automation engine acting on telemetry (same dependency), OTA rollout UI (needs the `cap_platform` signed-command path + rollback safety net), mTLS, AI Agent secret-push (needs `cap_platform` too).

---

## I. Roadmap

- **MVP** (§H) — fleet visibility + command console + capability discovery, on top of *only* what ESP-Claw does today.
- **V1** — build the two named ESP-Claw extensions (`cap_telemetry` push leaf, `cap_platform` signed-command path) → unlocks real telemetry graphs, automation engine, reliable bulk OTA with rollout %, and AI agent secret push. Add OTA rollback safety (bootloader rollback config) before enabling fleet-wide OTA campaigns. Add mTLS as an option alongside username/password.
- **V2** — device groups with edge-automation fallback (store-and-forward during MQTT outage — this needs an on-device queue/buffer capability, another named ESP-Claw extension, not assumed to exist), notification channels (Telegram — you already have IM capabilities on-device to mirror this pattern from; email; web push), observability stack (Prometheus/Grafana/Loki/OpenTelemetry) for the platform itself.
- **Enterprise** — full multi-tenant self-service (billing, per-org broker isolation or per-org ACL namespaces), Kubernetes deployment, EMQX clustering, Go-based ingest hot-path if device count genuinely reaches the six-figure range, LoRaWAN/Modbus/Zigbee/Matter/OPC-UA gateways only if a real customer need appears (per item 40's own instruction not to pre-build these).

---

## J. Questions Before Implementation Starts

Only asking what a sound engineering default can't resolve on its own:

1. **Broker topology:** your real device's `mqtt_broker` is currently a CloudAMQP SaaS instance. Should the platform (a) run its own EMQX and you migrate devices' `mqtt_broker` config to point at it, or (b) have the platform's backend simply be another MQTT client of your existing CloudAMQP broker (no EMQX container at all)? This changes the Docker Compose contents and the ACL story in §G.
2. **Network reachability:** will the platform run on this same LAN/Tailscale tailnet as your dev device, or on a separate server/VPS with a real domain? Determines the TLS-cert strategy (self-signed/Tailscale vs. Let's Encrypt) and whether the frontend needs a public hostname at all for MVP.
3. **Config authority:** should the platform become the primary way to change device Wi-Fi/MQTT/VPN/agent settings (writing via the `cap_platform` path once built), with the on-device Web UI/Telegram staying as a local/emergency fallback — or do you want them to stay fully independent (platform is read-mostly/command-only, humans still configure locally)? This shapes whether Phase 6 prioritizes building `cap_platform`'s config-push side or just its OTA/restart side first.
4. **AI Agent secret push, confirmed scope:** item 9 asks for per-device model/provider configuration from the platform. Given §0's finding that ESP-Claw doesn't mask secrets on read, I'm designing this as **push-only** (platform holds the vault, never reads a device's current key back) — confirming that's acceptable before I lock the `agents`/`device_credentials` schema and the `cap_platform` design around it.
5. **Realistic near-term device count** (not the eventual "millions" aspiration) — a handful of prototypes, or tens, over the next 1–2 months? This only affects whether MVP's EMQX runs single-node (fine into the thousands) — I'd default to single-node unless you tell me otherwise, just confirming before I write it into the Compose file.

Once these are answered, Phase 2 (Repository Structure) is next — still no implementation code until that's laid out and confirmed.
