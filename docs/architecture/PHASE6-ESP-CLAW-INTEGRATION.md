# Phase 6 — ESP-Claw Integration (capability catalog + local API)

Status: **implemented, builds clean, unit tests green (protocol + backend).** The new
`device_capabilities` migration has **not yet been run against the real Postgres in this
session** — the tailnet host that carries both the DB (100.108.45.123:5432) and the test
devices became unreachable mid-verification (the local `tailscaled` service stopped). Migrations
`0001`/`0002` were run live against that same DB earlier this session, and `0003` is plain
additive DDL, but it is not claimed as verified-live until it's been seen running (same honesty
rule as PHASE5-DATABASE.md).

## What this phase adds

The ESP-Claw integration/adapter layer (PHASE1-ANALYSIS.md §item-8, §K) — the **one-shot local
introspection pull**, distinct from the ongoing MQTT data path (which is Phases 4/5 and stays the
only live channel).

- **`@esp-claw/protocol` → `capabilities.ts`** — Zod schema for the device's real
  `GET /api/capabilities` response, **grounded in the firmware** (`http_server_capabilities_api.c`):
  `{ items: [{ group_id, display_name, default_llm_visible }] }`. Groups only — the firmware does
  **not** expose per-tool descriptors (id/family/kind/cap_flags/JSON-Schema) over HTTP, so we do
  not model them (brief rule #38). Also `LocalStatusSchema` for `GET /api/status`, and helpers
  `parseCapabilityCatalog` / `capabilityGroupIds` / `parseLocalStatus`.
- **`apps/backend/src/esp-claw/local-api-client.ts`** — `LocalApiClient`: fetches a single
  device's `/api/capabilities` and `/api/status` over the tailnet, with a timeout and Zod
  validation. **Security by construction:** an `ALLOWED_PATHS` allow-list means there is no code
  path that can fetch `/api/config` — which returns `mqtt_password` / `wg_private_key` / LLM
  `api_key` in plaintext (PHASE1-ANALYSIS.md §K). Secrets are never pulled up into the platform.
- **`device_capabilities` table** (migration `1700000000003`) + `DeviceCapability` entity — one
  row per (device, capability group). Composite PK `(device_id, groupId)`, FK to `devices` with
  `ON DELETE CASCADE`, index on `groupId` to answer "which devices have `cap_ota`?". Two columns
  added to `devices`: `localApiBaseUrl` (the device's tailnet URL, nullable until known) and
  `capabilitiesRefreshedAt`.
- **`DevicesService.refreshCapabilities(id, baseUrl?)`** — pulls the catalog and upserts the rows
  in a transaction (existing rows kept → `firstSeenAt` preserved; groups no longer present are
  removed), then records `localApiBaseUrl` + `capabilitiesRefreshedAt`. **`listCapabilities(id)`**
  reads them back.
- **API** — `GET /devices/:id/capabilities` (stored groups) and
  `POST /devices/:id/capabilities/refresh` (`{ baseUrl? }`) — introspection only.

## Verification performed

```
pnpm -r build        → exit 0 (protocol, then backend)
pnpm -r test         → 33 passed: protocol 22 (topics 9, envelope 8, capabilities 5),
                       backend 11 (mqtt integration 5, local-api-client 6)
```

`local-api-client` tests stub global `fetch` — they assert the real `/api/capabilities` shape
parses, a bare host gets an `http://` scheme, and a non-200 throws. No real device is contacted.

## ⚠️ Not verified live yet — do this once the tailnet is back

```bash
export DATABASE_URL=postgres://esp_claw:esp_claw_dev_only@<pg-host>:5432/esp_claw_platform
pnpm --filter @esp-claw/backend exec typeorm-ts-node-commonjs migration:run -d src/database/data-source.ts
# expect: AddDeviceCapabilities1700000000003 applied → device_capabilities table + the two devices columns

# Against a real device reachable on the tailnet (its local HTTP, e.g. http://100.108.45.150):
curl -X POST localhost:3000/devices/<device_id>/capabilities/refresh \
  -H "Content-Type: application/json" -d '{"baseUrl":"http://<device-tailnet-ip>"}'
curl localhost:3000/devices/<device_id>/capabilities
# expect: the device's real capability groups (cap_mqtt, cap_vpn, cap_ota, cap_system, ...) persisted and listed
```

## Next

Phase 7 (Frontend Dashboard): fleet summary tiles + device table + device detail showing what's
actually knowable today — status/last_seen, the capability groups from this phase, and a raw
command console — over REST now, WebSocket/SSE in Phase 8 (PHASE1-ANALYSIS.md §H MVP).
