# Digital Twin / Device Shadow — Architecture Evolution §18

Status: **implemented and live-verified** against the real tailnet Postgres. Buildable today with
**zero firmware changes**, exactly as §18 scoped it.

## What exists

- **`device_shadows`** table (migration `1700000000006`): one row per device, created lazily on
  first write (either an operator setting `desired`, or the poller reporting a value) — not
  pre-created for every device.
- **`DeviceShadow` entity** — `desired`/`reported` are flat, same-key-name jsonb objects
  (`desired.pump` vs `reported.pump`), matching §18's own example exactly, so drift detection is a
  plain per-key comparison rather than a schema mapping between two different shapes.
- **`TwinService`**
  - `getShadow(deviceId)` — never 404s; a device with no row yet returns an empty, in-sync shadow.
  - `setDesired(deviceId, patch)` — operator-authored intent. **Every call bumps `desiredVersion`**,
    even with unchanged values — it's a record of "an operator asked for this, at this time,"
    matching AWS IoT Shadow's own versioning convention (version tracks accepted updates, not value
    diffs). Does **not** attempt to push anything to the device — see "Not done" below.
  - `mergeReported(deviceId, samples)` — called from `TelemetryPollerService` right after it records
    a poll result, reusing the **exact same extracted scalar fields** (`extractSamples()`,
    unchanged) that already feed the telemetry hypertable. One extraction, two consumers: a
    time-series row per sample, and a "latest value" snapshot in the shadow. No-op for an empty
    sample list (nothing recorded that cycle).
  - Drift = keys present in `desired` whose value differs from `reported[key]` (missing-in-reported
    counts as drift too, via `!==` against `undefined`).
- **`TwinController`** — `GET /devices/:id/shadow`, `PUT /devices/:id/shadow/desired` (protected by
  the global `JwtAuthGuard` from the Identity pass — this feature landed *after* auth, so it's
  guarded automatically, not as an afterthought).

## Verification performed

```
pnpm -r build   → exit 0
pnpm -r test    → 56 passed (protocol 22, backend 34 — 6 new: twin.service.test.ts)
```

`twin.service.test.ts` uses the same in-memory-repository style as `identity.service.test.ts`.
Covers: empty shadow for an unknown device, `desiredVersion` incrementing on every `setDesired` call
(including unchanged values), `mergeReported` being a true no-op on an empty sample list (no row
created), numeric/boolean samples landing as plain values, drift detected only on keys present in
`desired`, and a device becoming back in-sync once `reported` catches up.

**Then live-verified against the real tailnet Postgres:**

```
migration:run → CreateDeviceShadows1700000000006 executed

node dist/main.js → TwinController routes mapped, boots clean

POST /auth/register                                  → token (bootstrap admin)
GET  /devices/no-such-device/shadow  (with token)     → 404
POST /devices/test-shadow-device/commands             → auto-registers the device (findOrCreate),
                                                          command itself fails at the MQTT step
                                                          (no MQTT_URL here) — irrelevant to this test
GET  /devices/test-shadow-device/shadow               → 200 {desired:{}, reported:{}, ..., inSync:true}
PUT  /devices/test-shadow-device/shadow/desired
     {"sampling_interval":30,"pump":true}             → 200, desiredVersion:1, drift:["sampling_interval","pump"]
PUT  ...same endpoint, no Authorization header        → 401  (confirms the global guard covers this
                                                                 new route with no extra wiring needed)

# cleanup: DELETE FROM users; DELETE FROM devices WHERE id='test-shadow-device'
# (cascades to the shadow + command rows via the existing FK ON DELETE CASCADE)
```

## Not done (explicitly, not forgotten)

- **Reconciliation / auto-push of `desired` to the device** — this pass only *stores* intent and
  *detects* drift. Actually pushing a `desired` change to the device is separate, later work:
  non-restricted fields could go over the existing command/response path today; anything mapping to
  a `RESTRICTED`/`ROOT_AGENT_ONLY` capability is blocked on the `cap_platform` firmware design
  (`ARCHITECTURE-EVOLUTION.md`'s firmware proposals) exactly as §18 itself says — modeling this
  honestly means *not* building a push mechanism that would either silently fail for restricted
  fields or need to special-case them without the real signed-token path existing yet.
- **Field-level restricted/unrestricted classification** — the shadow doesn't know which `desired`
  keys are "safe" vs "need cap_platform" — that mapping only matters once reconciliation exists, so
  designing it now would be guessing at a shape the reconciliation work will actually need.
- **`reported` is only ever what `TelemetryPollerService` already polls** (`mqtt_status`,
  `vpn_status`, `network_status`, `ota_status`'s scalar fields) — a `desired` key that doesn't
  correspond to any of those will show permanent drift until either a new poll target is added or a
  device pushes that value through some other path. Not a bug — an honest reflection of what's
  observable today.
