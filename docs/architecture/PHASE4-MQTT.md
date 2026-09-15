# Phase 4 — MQTT Integration

Status: **implemented and verified** against a local test broker. End-to-end verification against
the real CloudAMQP broker + a real device is a manual step for you to run (see below) — this
codebase never holds your MQTT credentials.

## What exists

`apps/backend/src/mqtt/` — the single place in the backend that touches the `mqtt` (mqtt.js)
client library. Everything else depends on `MqttService`'s methods, never on raw MQTT calls,
continuing the adapter-layer discipline from Phase 3.

- **`MqttService`** — one shared connection to whatever broker `MQTT_URL` points at (decision #1:
  CloudAMQP, not a self-hosted broker). On connect, subscribes broadly (`#`) and routes every
  message through `TopicService.parse()` — correct regardless of a tenant's `base_topic` depth
  (a fixed-depth wildcard like `+/+/status` would silently break for `espclaw/acme-farms/...`).
  - **Presence tracking**: an in-memory `Map<deviceId, {online, lastSeenAt}>`, updated from the
    real `status` leaf's birth/LWT payload shape (`{"online": true|false}`).
  - **Command/response**: `sendCommand(deviceId, {name, input}, {baseTopic?, timeoutMs?})` —
    publishes the exact `{id, action:"capability", name, input}` envelope verified live against
    real hardware this session, correlates the reply by `id` via an in-memory pending-map, resolves
    or times out. Correlation is deliberately in-memory (correct for one backend instance);
    moving it to Redis is explicitly deferred to Phase 8, when horizontal scaling actually needs it
    — not built ahead of that need.
  - **Graceful degradation**: if `MQTT_URL` is unset, the service logs a clear warning and the rest
    of the app still boots and serves `/health`, `/esp-claw/*`, etc. normally — a missing broker
    config doesn't take down unrelated functionality.
- **`MqttController`** — debug/acceptance-test HTTP surface (not the final Command Service API —
  no auth, no DB-backed history yet; that's a later refinement once Phase 5 exists):
  - `GET /mqtt/status` → `{configured, connected}`
  - `GET /mqtt/presence` / `GET /mqtt/presence/:deviceId`
  - `POST /mqtt/devices/:deviceId/commands` — body `{name, input?, baseTopic?, timeoutMs?}`

## Verification performed (no real credentials involved)

An integration test (`apps/backend/test/mqtt/mqtt.service.integration.test.ts`) spins up a local,
in-process MQTT broker (`aedes`, pure JS, ephemeral port) and a simulated device client that
replies exactly like the real firmware's `cap_mqtt` bridge does, then exercises `MqttService`'s
real logic against it:

```
✓ tracks presence from the real birth-message shape
✓ updates presence to offline on the real LWT payload shape
✓ sends a real capability command and resolves with the device's response
✓ rejects when no response arrives before the timeout
✓ respects an explicit tenant-scoped baseTopic override

Test Files  1 passed (1)
     Tests  5 passed (5)
```

Additionally verified by actually booting the app:
```
$ rm -f apps/backend/.env   # no MQTT_URL at all
$ node apps/backend/dist/main.js
  [MqttService] MQTT_URL not set — MQTT integration is inactive. Set it in .env to connect...
  [NestApplication] Nest application successfully started
$ curl localhost:3000/mqtt/status
  {"configured":false,"connected":false}
$ curl localhost:3000/health
  {"status":"ok", ...}                      # unaffected — confirms graceful degradation
```

## ⚠️ Real-world risk to verify yourself against CloudAMQP (not assumed solved)

RabbitMQ's MQTT plugin (what CloudAMQP runs) has had **varying retained-message support across
versions/plans** — this platform's whole presence design (§C in PHASE1-ANALYSIS.md) depends on a
device's retained `status` message being delivered *immediately* on subscribe, not just on future
transitions. I cannot check your specific CloudAMQP plan's behavior without your credentials.
**Please verify this yourself** before relying on presence in production:

1. Add your real broker URL to `apps/backend/.env` (copy `.env.example`, fill in `MQTT_URL`).
2. Start the backend: `pnpm --filter @esp-claw/backend start`.
3. With a real device already online (so it already published its retained birth message before
   the backend connected), check: `curl localhost:3000/mqtt/presence/<your-device-id>`.
   - **If it immediately shows `online: true`** — retained messages work on your plan, presence
     tracking is reliable as designed.
   - **If it shows nothing until the device's next reconnect/status change** — retained delivery
     isn't working as expected; tell me and I'll add a documented mitigation (e.g. a periodic
     `get_system_info` poll as a presence backstop) rather than silently shipping unreliable
     presence.

## Try it against your real device right now

Using the real device id from this session (`ecda3b4ff7d4`) and a capability that's always safe to
call (`CALLABLE_BY_LLM`, not restricted):

```bash
curl -X POST localhost:3000/mqtt/devices/ecda3b4ff7d4/commands \
  -H "Content-Type: application/json" \
  -d '{"name":"get_current_time"}'
```

Expected: the real response from your real device, through this new platform backend, over your
real CloudAMQP broker — the same round-trip proven with the local test broker above, now for real.

## Next

Phase 5 (Database): persist devices/commands so `MqttController`'s debug endpoints can be replaced
by a real Device Registry + Command Service with history, instead of living entirely in memory.
