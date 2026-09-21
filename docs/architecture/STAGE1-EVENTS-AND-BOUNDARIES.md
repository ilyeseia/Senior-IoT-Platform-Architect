# Stage 1 — Events, module boundaries, API and observability foundations

Approved 2026-09-21 from `ADVANCED-ARCHITECTURE-AUDIT.md` §29. Additive: no existing table is
changed except one nullable column; existing routes keep working. Rollback: `git revert` plus the
`down()` of migrations `0007`/`0008` (see below).

## 1. What was built

### 1.1 Platform kernel (`src/platform`) — events and request context
* **`DomainEvent` envelope** (`event_id, event_type, schema_version, timestamp, device_id, organization_id, source, correlation_id, causation_id, trace_id, span_id, sequence, idempotency_key, payload`).
  Unpopulated fields are `null`, never absent (`organization_id` until Stage 2, `sequence` until edge store-and-forward).
* **`EventBus` port** — the only way modules talk to each other asynchronously. Guarantees an adapter must keep:
  asynchronous publish (an enqueue), at-least-once delivery (consumers must be idempotent), **per-device ordering**,
  failure isolation. `InProcessEventBus` adds per-handler timeout (10 s), opt-in retries with backoff, and `drain()`.
  `EventEmitter2` and `@nestjs/event-emitter` are gone.
* **Request context** (`AsyncLocalStorage`): `x-correlation-id` (accepted only as `[A-Za-z0-9._-]{1,128}`, otherwise replaced — it is echoed in a header and logged) and W3C `traceparent` → `trace_id`/`span_id`. Every event and command created while handling a request carries them.

### 1.2 Event catalog (`src/platform/events/event-types.ts`)
| Event | Published by | Consumed by | Audited |
|---|---|---|---|
| `device.presence.reported` | gateway (`mqtt`) | `devices` | no (raw observation) |
| `device.registered` / `device.online` / `device.offline` | `devices`, on real transitions only | `audit` | yes |
| `device.command.created` / `device.command.completed` | `commands` | `audit`, `observability` | yes |
| `device.telemetry.updated` (carries the samples) | `telemetry` | `twin`, `observability` | no (high volume) |
| `device.state.changed` | `twin` (operator set desired) | `audit` | yes |

`device.online`/`offline` carry `causation_id` = the presence event and the same `correlation_id`; a command's two events carry `causation_id` = the command id and share its correlation id.
The registry now applies one device's presence observations **in order** — this fixes audit B6 (a fast online→offline flap could land backwards).

**Adding an event:** add the type + payload to `event-types.ts`, publish with `createEvent(...)`, subscribe with `bus.subscribe(pattern, handler, { name })`. Make the handler idempotent. Decide whether it belongs in `isAuditedEventType`.

### 1.3 Audit module (`src/audit`) — append-only history
`event_log` (migration `0007`): PK `event_id` (recording is idempotent, `ON CONFLICT DO NOTHING`), `seq` cursor, indexes on device / type / correlation. **Append-only is enforced by triggers** (UPDATE and DELETE per row, TRUNCATE per statement are rejected for every writer). `GET /audit/events?device_id&type&correlation_id&before_seq&limit` (cursor paging, ≤ 200). Retries 3× with backoff. It records only `isAuditedEventType` events.
`commands.correlation_id` (migration `0008`, nullable): ties a command to the request that created it.

### 1.4 Module boundaries (`test/architecture/module-boundaries.test.ts`)
Every module has an `index.ts` (its public API). The test reads the real imports and fails on: reaching into another module's internals; a dependency outside `ALLOWED`; a cycle; the kernel/shared libs depending on a feature module. Verified by injecting each kind of violation. Current graph:

```
platform, common, config      (leaves; anyone may use them)
database  identity  audit  esp-claw            depend on nothing
mqtt -> esp-claw      devices -> esp-claw
commands -> devices, mqtt        telemetry -> devices, commands
twin -> devices                  health -> identity, mqtt      observability -> mqtt
app.module / main                 composition root: every module's public API
```
`DatabaseModule` no longer imports entities (`autoLoadEntities`; each module registers its own). The former `twin <-> telemetry` cycle is gone: telemetry publishes samples, the twin subscribes.

### 1.5 API conventions
* **Versioning:** `/v1/...` (URI). The same routes still answer **without** the prefix (`VERSION_NEUTRAL`); those responses carry `Deprecation: true` and `Link: </v1/...>; rel="successor-version"`. Retire the old paths by dropping `VERSION_NEUTRAL` in `main.ts`.
* **Error envelope** (every endpoint): `{"error":{"code","message","status","details"?,"correlation_id"}}`. `code` is stable (`invalid_request, unauthorized, forbidden, not_found, conflict, too_many_requests, unavailable, internal_error`). Unexpected errors never leak message or stack; they are logged under the correlation id.
* Pagination exists on `/audit/events` (cursor); the older list endpoints are unchanged.

### 1.6 Observability
* `GET /health`, `/health/live` — liveness, public, never touches a dependency. `GET /health/ready` — public; **503 when the database is down**; MQTT is reported (`up|down|disabled`) but does not fail readiness.
* `GET /metrics` — Prometheus, **behind the JWT guard** (send a bearer token). HTTP latency by method/route **template**/status, command latency by status, events by type, event-bus counters, `esp_claw_mqtt_connected`, default process metrics. Private registry.
* JSON logs: `LOG_FORMAT=json` (default when `NODE_ENV=production`) → one JSON line with `level, time, context, msg, correlation_id`.

## 2. Breaking / behavioural changes
* Error responses have a new body shape (previously Nest's `{statusCode,message,error}`).
* Presence is now event-driven: `device.status` (EventEmitter2) is replaced by `device.presence.reported`.
* `@nestjs/event-emitter` removed; `prom-client` added.
* Migrations `0007`, `0008` run on next boot (`migrationsRun: true`) — **not yet applied to the shared dev database**.

## 3. Verification
| Check | Result |
|---|---|
| `tsc --noEmit`, `nest build` | clean |
| Backend tests | **211 passed** (was 90): event bus (ordering, isolation, retry, timeout, no deadlock), envelope/context, presence transitions and the flap ordering, command/twin/telemetry events, audit service, error filter, versioning middleware, metrics, JSON logger, health, architecture test |
| Migrations `0007`/`0008` + `EventLogService` on the real dev Postgres, **in an isolated scratch schema** (dropped afterwards; `public` untouched) | up ok; duplicate delivery collapsed; non-audited events skipped; cursor paging and filters correct; `UPDATE`/`DELETE`/`TRUNCATE` rejected by the database; `down()` removes the table; no schema left behind |
| Real Nest app over HTTP (compiled `dist`, real guard/filter/versioning/metrics/health; DB and MQTT stubbed) | `/x` and `/v1/x` both 200 (unversioned carries `Deprecation`), `/v2/x` 404 envelope; 401/400/500 envelopes with correlation id; 500 does not leak; `/health` public, `/health/ready` 503 when DB down; `/metrics` 401 without token, Prometheus content type, route templates only. This run **found and fixed** a wrong `Content-Type` on `/metrics` |
| **Not verified** | The full `AppModule` was **not booted against the shared dev DB** (it would apply 0007/0008 there and run the B7 sweep); live MQTT event flow with a device; OpenAPI (deferred) |

## 4. Deliberately not done (and why)
* **Transactional outbox** — its job is DB→external-bus at-least-once delivery; with only an in-process consumer set there is nothing to relay to. The append-only `event_log` already covers durability of the important events. Add the outbox in the same change that introduces NATS (audit §20 triggers).
* **OpenAPI** — needs typed request/response schemas. The controllers use zod at runtime; generating the document is worth doing together with the DTO/`contract` work of Stage 2, not by decorating everything twice now.
* **Redis / NATS / Prometheus server / Grafana / Tempo** — not needed yet (audit §27).
* **Guaranteed persistence of every event across a crash** — the in-process bus does not provide it (documented on the port).

## 5. Rollback
1. Revert the code commits (the app runs without the audit module).
2. If `0007`/`0008` were applied: `typeorm migration:revert` twice — `0008` drops `commands.correlation_id`; `0007` drops `event_log` (the audit history is lost) and its function.
