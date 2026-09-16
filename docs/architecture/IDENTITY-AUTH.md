# Identity & Auth — closing Architecture Evolution §10 problem #2

Status: **implemented and live-verified** against the real tailnet Postgres (not just local tests).
This closes the single biggest gap flagged in `ARCHITECTURE-EVOLUTION.md` §10: "every REST endpoint
is open."

## What exists

- **`apps/backend/src/identity/`**
  - `User` entity — `id` (uuid), `email` (unique), `passwordHash`, `role` (`"admin"` only for now —
    no RBAC/permissions table yet; see "Not done" below). No `orgId`, matching the same
    "don't add a placeholder FK before multi-tenancy is real" discipline already applied to `Device`.
  - `IdentityService` — `register(email, password)`: **bootstrap-only**. Allowed exactly once, while
    the `users` table is empty; every subsequent call throws `ConflictException` (409). There is no
    open self-signup and no separate seed script — the first successful register *is* the seed.
    `login(email, password)`: verifies via `bcryptjs.compare`, throws `UnauthorizedException` (401)
    on any mismatch (wrong password or unknown email — same error either way, no user enumeration).
    Passwords are hashed with `bcryptjs` (pure JS, no native build step — chosen over `bcrypt` after
    the native module's build script failed in this environment; functionally identical API/output
    format).
  - `JwtAuthGuard` — registered **globally** via `APP_GUARD` (not per-controller), so a newly added
    controller is protected by default and has to opt out explicitly with `@Public()`, rather than
    silently being open because someone forgot to add a guard. Verifies the `Authorization: Bearer
    <token>` header via `@nestjs/jwt`, attaches the decoded `{sub, email, role}` payload to the
    request as `request.user`.
  - `IdentityController` — `POST /auth/register`, `POST /auth/login`, both `@Public()`. Body
    validated with the same "Zod `safeParse` → `BadRequestException` with a readable message"
    pattern already used by `mqtt.controller.ts`/`esp-claw.controller.ts`, not a new validation
    style.
  - `HealthController` — marked `@Public()` (the only other route that needs to stay open).
- **`JWT_SECRET`** promoted from optional to **required** in `env.validation.ts` (min 16 chars) —
  unlike `MQTT_URL`, there's no safe way to gracefully degrade a missing signing secret.
- **Migration** `1700000000005-CreateUsers.ts` — one `users` table, no `org_id`.

## Verification performed

```
pnpm -r build   → exit 0
pnpm -r test    → 50 passed (protocol 22, backend 28 — the 10 new tests are
                  identity.service.test.ts (4) + jwt-auth.guard.test.ts (6))
```

`identity.service.test.ts` uses a minimal in-memory stand-in for `Repository<User>` (only the
methods actually called) plus a real `JwtService` instance — no mocking framework, matching this
codebase's existing preference for real collaborators (`mqtt.service.integration.test.ts`'s real
`aedes` broker is the same philosophy). Covers: successful bootstrap + verifiable token, second
registration rejected, correct/incorrect login, and — the one worth calling out — an explicit
assertion that the plaintext password is never returned and the stored hash isn't the plaintext.

`jwt-auth.guard.test.ts` exercises the guard directly against a fake `ExecutionContext`: `@Public()`
routes pass with no token; protected routes reject missing/malformed/invalid/wrong-secret tokens
with `UnauthorizedException`; a valid token is accepted and its payload attached to the request.

**Then live-verified against the real tailnet Postgres** (same instance as the Phase 6/telemetry
verification), not just local/mocked tests:

```
migration:run   → CreateUsers1700000000005 executed

node dist/main.js  → boots cleanly, IdentityModule/JwtModule initialize, all routes mapped

GET  /devices                (no token)         → 401
GET  /health                 (no token)         → 200   (confirms @Public() still works)
POST /auth/register  {admin@example.com, ...}   → 200, real JWT + user object
POST /auth/register  (second attempt)           → 409   (bootstrap-only, confirmed live)
GET  /devices        (Bearer <token from above>)→ 200
POST /auth/login     (wrong password)           → 401

# cleanup: DELETE FROM users — so the real bootstrap flow is still available
# for whoever registers the actual first admin, not blocked by this test run.
```

## Not done (explicitly out of scope for this pass, not forgotten)

- **RBAC / multiple roles** — `role` exists as a column but only `"admin"` is ever assigned; a real
  permissions model is `PolicyModule` (§12 of the evolution doc), which needs more than one actor
  type to be worth designing — premature today.
- **Refresh tokens / logout / token revocation** — access tokens are short-lived (12h) and
  stateless; there's no server-side session to revoke. Fine for one admin operating the platform
  directly; revisit once there's more than one user or a real incident-response need to force a
  logout.
- **Rate limiting on `/auth/login`** — brute-force protection isn't in place yet; flagged, not
  silently assumed solved. Belongs at the same API-gateway/guard level as the rate-limiting
  mentioned in the evolution doc's §25, not reinvented here.
- **Guarding the debug `/mqtt/*` and `/esp-claw/*` endpoints** — these now inherit the global guard
  automatically (they weren't marked `@Public()`), which is a real, if incidental, improvement — but
  they're still legacy debug surfaces per `ARCHITECTURE-EVOLUTION.md` §6/§10.6, and retiring them
  outright is a separate decision, not bundled into this change.

## Next

With the biggest open gap closed, the next highest-value items per `ARCHITECTURE-EVOLUTION.md`'s
own sequencing are Digital Twin (§18, buildable today with zero firmware changes) or the two
firmware design proposals (`cap_platform`, MCP-url-on-status) once you're ready to work in
`esp-claw-2` again.
