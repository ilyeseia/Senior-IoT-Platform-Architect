# Firmware hardening (esp-claw-2) — audit §26-1

Approved 2026-09-20 ("fix the firmware first"). Closes the firmware findings of
`ADVANCED-ARCHITECTURE-AUDIT.md` §4.3. The changes live in the **`esp-claw-2`** repository
(working tree, not committed by this pass); this document is the platform-side record of what the
device now guarantees and what the platform can rely on.

## Finding → change

| Finding | Change in `esp-claw-2` |
|---|---|
| **S1** SUB_AGENT → SYSTEM escalation (plant a Lua file / router rule, run it as `SYSTEM`) | New descriptor flag `CLAW_CAP_FLAG_LOCAL_ONLY` and call-context field `remote_origin`. `cap_mqtt` and `cap_mcp_bridge` set `remote_origin`, so `LOCAL_ONLY` tools are **denied and absent from `claw_list`** for network callers. Flagged: `write_file`, `delete_file`, `copy_file`, `move_file`, `add_router_rule`, `update_router_rule`, `delete_router_rule`, `scheduler_add`, `scheduler_update`, `register_skill`, `unregister_skill`. Remote `lua_run_script[_async]` is limited to `<data>/scripts/remote/`; remote `http_request` rejects `save_path` (no download-then-run). |
| **S2** MQTT free text reaches the root agent | New config `mqtt_allow_text`, **default `"false"`**. Free-text payloads get `ok:false … free-text commands are disabled`. `mqtt_configure` cannot change it (an LLM must not re-open the path); set it via `/api/config` or the web UI (no UI control yet). |
| **S3** MCP server on by default, unauthenticated | `mcp_enabled` default → `"false"`. The SDK (`espressif/mcp-c-sdk` 2.0.1) has no server-side auth hook (its auth callback is client-side only), so the residual risk when enabled is documented, and `claw_call` still cannot reach `ROOT_AGENT_ONLY`/`LOCAL_ONLY` tools. |
| **S4-a…d** `cap_platform` | `platform_exec` targets an explicit allow-list: `ota_update`, `mqtt_configure`, `network_configure`, `vpn_configure`, `vpn_connect`, `vpn_disconnect`, `wireguard_configure`, `list_agents`, `inspect_agent`. **Not** allowed: `platform_exec`, `platform_configure`, `ssh_configure`, other agent tools. Token payload budget 384 → 768 decoded bytes, buffers moved off the task stack. Replay window and NVS-at-rest are unchanged (see residual risks). |
| **S5** OTA integrity + rollback | `ota_update` takes optional `sha256`; the image is hashed in the inactive slot **before** `esp_https_ota_finish()` switches the boot partition (mismatch ⇒ download discarded, running firmware untouched). `CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE=y`; `cap_ota` validates a `PENDING_VERIFY` image once the network is up (≥ 30 s uptime) and rolls back after 5 min without an address. |
| **S6** `RESTRICTED` not enforced | Documented as descriptive-only in `claw_cap.mdx`; enforcement is by `ROOT_AGENT_ONLY` / `LOCAL_ONLY`. |
| **B13** (platform) | Denials now read `Error: cap '<name>' is not exposed to the LLM (reason=<why>).`; the platform classifies them as `rejected`. |

## What the platform can now rely on
* A broker-credential holder (or any MCP client) can no longer plant persistent local-authority state.
* `status:"rejected"` in `commands` means an authorization denial, with the reason in `command_results.result`.
* `ota_update` with `sha256` is verified on-device; the platform must always send it (Stage 4 OTA module).
* `platform_exec` is the only path to root-only tools and only for the allow-list above.

## Prior hardware verification (from `origin/main`'s docs, not re-done here)
`cap_platform` in its original form (`bb9df36`) was live-verified on a real device by an earlier session: valid-token
escalation to a root-only capability, replay rejection, tampered signature, wrong device and expiry all rejected.
The allow-list, heap-allocated buffers and larger token budget in this pass **change that code** and have only been compiled.

## Verification status
| Check | Result |
|---|---|
| `idf.py build` (ESP32-S3 DevKitC-1, ESP-IDF 5.5.4, default config) | **Passed**: `edge_agent.bin` 0x2d0a60 bytes (44% of the 0x500000 app partition free). Compiled after the edits: `claw_cap`, `cap_mqtt`, `cap_mcp_bridge`, `cap_lua`, `cap_http_request`, `cap_ota`, `app_claw`, plus the flag edits in `cap_files`, `cap_router_mgr`, `cap_scheduler`, `cap_skill_mgr` |
| `cap_platform.c` | **Not in the default build** (`CONFIG_APP_CLAW_CAP_PLATFORM` is off). Compiled separately with it enabled: `cap_platform.c.obj` and `cap_ota.c.obj` built with exit 0. A **full link with `cap_platform` enabled was not run**; the temporary enable was reverted |
| `CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE=y` | Confirmed present in a freshly regenerated `sdkconfig` (`CONFIG_APP_ROLLBACK_ENABLE=y` too). The bootloader was **not** built/flashed with it |
| Flash + run on hardware | **not done** |
| OTA hash mismatch / rollback behaviour | **not done** (needs a device with the new bootloader) |
| MCP client compatibility | probe + static SDK analysis only (`spikes/mcp-device-probe/`, §MCP spike below) |

## Operator notes / behaviour changes
* Existing devices keep their stored `mcp_enabled`; a **fresh** or factory-reset device now starts with MCP off. Devices upgraded by OTA lose free-text MQTT until `mqtt_allow_text = "true"` is set.
* Rollback needs a **one-time serial re-flash** (bootloader is not updated by OTA). Until then `cap_ota`'s validation logic is inert (state is never `PENDING_VERIFY`).
* To let the platform run a Lua routine remotely, place it under `<data>/scripts/remote/` on the device.

## Residual risks (not addressed here)
* `cap_platform` replay window is 16 nonces in RAM (cleared on reboot); the 60 s TTL is the real defence. The signing secret is stored in plain NVS (no NVS/flash encryption, no secure boot).
* MCP HTTP, when enabled, is unauthenticated — LAN/tailnet only. Server-side auth needs an SDK change.
* The local HTTP API (`/api/config` returns secrets in plaintext, `/api/files`, `/api/lua/*`, `/api/restart`) is still unauthenticated on the LAN.
* Router rules and Lua run as `SYSTEM` by design; anything the owner installs locally is trusted.
* `http_request`, `mqtt_publish`, `memory_*`, `lua_run_script` (under `scripts/remote/`) remain remotely callable.
* Broker ACLs (per-device credentials, only the platform may publish `…/command`) are still required — the firmware changes reduce the blast radius, they do not replace them.

## MCP spike (audit §26-4)
Static analysis of `espressif/mcp-c-sdk` 2.0.1 (the SDK behind `cap_mcp_server`):
* Streamable HTTP, default target protocol `2025-11-25`, also accepts `2024-11-05`, `2025-03-26`, `2025-06-18`;
  JSON-RPC `initialize`, `notifications/initialized`, `tools/list` (cursor pagination, limit ≤ 128), `tools/call`,
  `resources/*`, `prompts/*`, `ping`; session id via `MCP-Session-Id` (TTL 10 min, expired ⇒ 404);
  `MCP-Protocol-Version` header validated; `Origin` checked against `Host` (DNS-rebinding mitigation);
  SSE on GET is enabled in this firmware's sdkconfig (`CONFIG_MCP_HTTP_SSE_ENABLE=y`); server-side OAuth is "partial/planned".
* Conclusion: **no protocol-level obstacle** to a standard Streamable-HTTP client; a platform MCP client can be written against the spec
  rather than a device-specific dialect. Defaults: port `18791`, endpoint `mcp`.
* **Not proven on a device.** `spikes/mcp-device-probe/probe.mjs` performs the handshake, lists tools, calls `claw_list`, asserts that
  `LOCAL_ONLY` tools are hidden, and optionally calls one capability through `claw_call`. It was exercised against a mock server only
  (JSON and SSE bodies, pagination, leak detection, error exit codes). Run it against a real device after enabling MCP:
  `node spikes/mcp-device-probe/probe.mjs http://<device>:18791/mcp --call get_current_time`.
* Design consequence (unchanged from the audit): the MCP Gateway prefers the MQTT `capability` path to reach devices; device MCP over HTTP is
  an optional secondary transport, and `claw_list` only returns names/descriptions (no schemas) until a `claw_describe` tool exists.
