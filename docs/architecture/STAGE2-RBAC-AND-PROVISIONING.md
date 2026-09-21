# Stage 2 — RBAC, session revocation, and privileged device operations

Approved 2026-09-21 ("start Stage 2") from `ADVANCED-ARCHITECTURE-AUDIT.md` §22, §29. Two slices were
built: **(A) roles/permissions with immediate revocation** and **(B) the platform side of the
device's `platform_exec` trust path**. Organizations (`org_id`) and per-device broker credentials
were **not** started — see §5 for why and what is needed.

## 1. Roles, permissions, revocation (slice A)

### 1.1 Model (`src/platform/auth`)
| Role | Permissions |
|---|---|
| `viewer` | `devices:read`, `commands:read`, `twin:read`, `telemetry:read` |
| `operator` | viewer + `devices:write`, `commands:dispatch`, `twin:write` |
| `admin` | everything, adding `audit:read`, `metrics:read`, `users:manage`, `devices:privileged` |

An unknown or stale role has **no** permissions (fail closed). Roles and permissions are code, reviewed
together with the routes they protect — not runtime data.

### 1.2 Every route declares who may call it
`@Public()`, `@AnyAuthenticated()` or `@RequirePermission(p)`. `PermissionsGuard` (second global guard,
after `JwtAuthGuard`) **refuses a route that declares nothing**, and `test/architecture/route-permissions.test.ts`
fails the build for one (verified with an injected unannotated route). Public routes are pinned by that
test to exactly: `/health*` and `/auth/register`, `/auth/login`.

### 1.3 Decisions use the account as it is now, not the token
The guard loads the account (cached ≤ 10 s, `USER_STATE_TTL_MS`) and uses its **current** role and state:
* demote a user → their existing token has the new (lower) permissions immediately;
* **disable** a user → existing tokens stop working; login fails with the same message as a wrong password;
* **password change / admin reset / disable** bump `users.tokenVersion`; JWTs carry `tv` and are refused when older
  (tokens issued before this change have no `tv` and count as 0, so they keep working until the first revocation).
Across several backend instances a revocation is effective within the cache TTL; on the instance that made the change, at once.

### 1.4 User management (admin)
`POST /users`, `GET /users`, `PATCH /users/:id` (`role`, `disabled`), `POST /users/:id/password`; for everyone:
`GET /auth/me` (live role + permissions), `POST /auth/password` (needs the current password; returns a fresh token).
**The last active admin can never be demoted or disabled** — checked inside a transaction under the same advisory
lock as registration, so two simultaneous demotions cannot both succeed.

### 1.5 Security events (audited, append-only)
`security.user.created`, `security.user.updated`, `security.password.changed`, `security.login.succeeded`,
`security.login.locked` (once when a lockout starts, not per failed attempt — otherwise an attacker could grow an
immutable log). Events carry ids and emails, **never** passwords or hashes (tested).

## 2. Privileged device operations (slice B)

### 2.1 What it is
The device firmware (`cap_platform`, esp-claw-2) runs a root-only capability only for a signed, short-lived,
device-bound, single-use token. This stage adds the **issuer** and a governed way to use it:
`POST /devices/:id/privileged { capability, input, timeoutMs? }` (**admin only**, `devices:privileged`) and
`GET /privileged/targets`.

Allowed targets (must equal the firmware allow-list — a test compares against `cap_platform.c` when the sibling
repository is present): `ota_update, mqtt_configure, network_configure, vpn_configure, vpn_connect, vpn_disconnect,
wireguard_configure, list_agents, inspect_agent`. Not signable: `platform_exec`, `platform_configure`, `ssh_configure`,
the other agent tools.

### 2.2 Token and key handling
* Format identical to `cap_platform.c`: `base64url(payloadJSON) + "." + base64url(HMAC-SHA256(secret, ASCII of the first segment))`,
  payload `{device_id, capability, input, issued_at, expires_at, nonce}`, TTL 60 s, nonce 128-bit random.
* **Per-device secret = HKDF-SHA256(master, salt `esp-claw/platform_exec/v1`, info = device_id).** One env value
  (`PLATFORM_MASTER_KEY`, base64url, ≥ 32 bytes) — nothing per device is stored; a leaked device secret exposes neither the
  master key nor another device. Without the key these endpoints answer 503 and nothing else changes.
* **`issued_at` is backdated by 25 s.** The device accepts only `now ∈ [issued_at − 5, issued_at + 60]`; issuing at "now"
  would reject any device whose clock is more than 5 s behind. Backdating makes the tolerance ≈ ±30 s.
* The platform enforces before signing: target allow-list; payload ≤ 768 bytes (422 otherwise); `ota_update` **must** carry an
  `https://` url and the image `sha256` (the device verifies it before activating the slot) — an unverified OTA is never sent.

### 2.3 What is stored — and what is not
The wire carries `platform_exec` + token. The **command history and the events** record the logical operation
(`platform_exec:ota_update`) with credential-looking fields (`password`, `secret`, `token`, `private…`, `api_key`, `psk`…)
**redacted** — viewers can read command history and must not obtain a replayable token or a broker password. Each execution also emits
an audited `security.privileged.executed` event naming the admin. Device-side refusals (bad signature, expired, replay, wrong
device, target not allowed, not provisioned) are classified `rejected`, not `failed`.

### 2.4 Provisioning a device (once, locally)
```
PLATFORM_MASTER_KEY=… pnpm --filter @esp-claw/backend platform:secret <device_id>     # prints the device's secret
# on the device itself (console / local web chat / Telegram as its owner — NEVER over MQTT):
platform_configure {"secret": "<printed value>"}
```
`platform_configure` is root-only and deliberately not on the allow-list, so a remote party cannot replace the secret.
The secret is never returned by any HTTP endpoint. The `cap_platform` group is off by default in the firmware
(`CONFIG_APP_CLAW_CAP_PLATFORM`).

## 3. Migration
`0009` adds `users.disabledAt` (nullable) and `users.tokenVersion` (default 0). Additive; existing users stay enabled at
version 0. Rollback: `down()` drops both columns. **Applied to the shared dev database on 2026-09-21** (`migration:run`; `users` had 0 rows; columns verified).

## 4. Verification
| Check | Result |
|---|---|
| `tsc --noEmit`, `nest build` | clean |
| Backend tests | **345 passed** (was 211): role matrix, `PermissionsGuard` (live role, revoked `tv`, disabled, fail-closed), user management, last-admin rule incl. concurrent demotions, revocation + cache TTL, password flows, security events (no secrets in events), route-permission architecture test, token tests |
| Token vs. independent implementations | an HMAC vector and an HKDF vector computed with **openssl**, and a **complete token** built by an independent Python + openssl implementation, match this code byte for byte; the `platform:secret` script's output equals the openssl HKDF vector |
| Token vs. the device logic | a line-by-line **port of `cap_platform_exec_execute`** (test helper) accepts every allowed target and refuses tampering, wrong secret/device, expiry, replay, oversize, unprovisioned; end-to-end (controller → `CommandsService` → the port) proves what is stored/announced contains neither the token nor a password |
| Real Nest app over HTTP (compiled guards/controllers, in-memory user repository) | viewer/operator/admin see 200/201/403 as specified; 403/401/409/400 envelopes; a live token is refused right after demotion, disabling, and a password change; demoting the only admin → 409 |
| Migration `0009` in an isolated scratch schema with a pre-existing user | up: row stays `admin`, enabled, version 0; down: columns gone; schema removed |
| **Not verified** | **a real device**: the token has never been presented to real `cap_platform` firmware from this platform (only to a port of its logic) — do this before relying on it: provision one device, then `POST /devices/:id/privileged {"capability":"list_agents"}`. The firmware changes this depends on (allow-list, larger payload) are compiled but not flashed. Migration `0009` is applied on the dev DB. A ready-made probe and runbook exist: `DEVICE-TEST-RUNBOOK.md` (`pnpm run device:probe`). |

## 5. Not built in this stage (and why)
* **Organizations / `org_id`.** Needs a tenancy decision first: one default organization, or one per customer; and how a device
  maps to an organization (the `base_topic` prefix is the only existing, firmware-free carrier). It touches every table and query
  and is hard to undo, so it should follow that decision rather than guess.
* **Per-device broker credentials + topic ACLs.** Blocked on the CloudAMQP plan question (still unverified) and on the provider's
  admin API access. The *push* side now exists: a new broker user/password can be delivered to a device with
  `mqtt_configure` through the privileged path (password redacted in history).
* **`device_tools` discovery** needs the firmware's `claw_describe` addition (per-tool schemas are dropped by `claw_list`).

## 6. Residual risks
* The device's replay window is 16 nonces in RAM and is cleared on reboot; only the 60 s TTL protects then (modelled in a test).
* The signing secret sits in plain NVS on the device (no NVS/flash encryption).
* A leaked `PLATFORM_MASTER_KEY` allows deriving every device's secret: keep it in the environment/secret store, back it up, rotate deliberately
  (rotation means re-provisioning every device).
* `viewer` can read command history: the redaction is name-based; a credential under an unusual field name would be stored. Prefer the fields the firmware actually uses.
* Bcrypt cost, in-memory login throttle and the 10 s state cache are per instance.
