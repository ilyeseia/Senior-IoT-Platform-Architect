# Device test runbook — proving `platform_exec` on real hardware

Goal: close the largest open verification gap (STAGE2 doc §4): the token has only ever been checked against a
**port** of the firmware logic. This runbook takes ~30 minutes and needs **one** ESP-Claw device and its MQTT broker.
Nothing in it changes device configuration except installing the signing secret; every probe is read-only or a deliberate refusal.

## 0. What you need
* One device already connecting to your broker (`mqtt_status` works today) and **firmware built with `CONFIG_APP_CLAW_CAP_PLATFORM=y`** (§1).
* This repository checked out (Node ≥ 20, `pnpm install` done), the broker URL with credentials (`MQTT_URL`), and a `PLATFORM_MASTER_KEY`.
* Serial access **or** the device's SSH console (`cap_ssh`) or its local web UI — needed once, to install the secret (§3).

Generate the master key once and keep it in your secret store (losing it = re-provisioning every device):
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

## 1. Firmware with `cap_platform`
`cap_platform` is **off by default** (`CONFIG_APP_CLAW_CAP_PLATFORM`, "opt-in until proven on real hardware"). With `enabled_cap_groups`
empty (the default) every compiled group is registered, so building it in is enough.

```bash
cd esp-claw-2/application/edge_agent
idf.py bmgr -c ./boards -b <your_board>            # the board you normally build
echo "CONFIG_APP_CLAW_CAP_PLATFORM=y" >> sdkconfig.defaults     # local, do not commit
rm -f sdkconfig
idf.py build
```
The build in this session used `esp32_S3_DevKitC_1`; if your board differs, rebuild with yours.

**Flash without wiping the device's data.** The full `idf.py flash` (and the printed `write_flash` line) also writes `storage.bin`, which
**overwrites the device's stored configuration** (Wi-Fi, LLM keys, MQTT settings). Flash only the bootloader and the app:
```bash
idf.py -p <PORT> bootloader-flash app-flash
```
The bootloader now has app rollback enabled (`CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE`), which OTA can never install — this one serial flash is
what turns rollback on for this device. (An image flashed over serial is not "pending verification"; the `New firmware validated` log line appears
only for images installed later by OTA, once Wi-Fi is up.)

Also new by default in this firmware (see `esp-claw-2/CHANGELOG.md`): free-text MQTT commands are **off** (`mqtt_allow_text`), and the MCP
server is **off**. `{"action":"capability",…}` commands — everything the platform uses — are unaffected.

## 2. Confirm the device is online and the group is registered
```bash
# via the platform (Stage 0/1 API) or any MQTT client: the birth message must be {"online":true}
```
On the serial console (`idf.py monitor`, prompt `app> `): `cap list` should show `platform_configure` and `platform_exec`.

## 3. Install the signing secret — locally, never over MQTT
On your workstation:
```bash
cd apps/backend
PLATFORM_MASTER_KEY=<your key> pnpm run platform:secret <device_id>      # prints one base64url line
```
On the **device itself**, run the tool **from the console or SSH console — not from a chat with the agent**:
```
# serial console (idf.py monitor):
cap call platform_configure '{"secret":"<the printed line>"}'
# or, over the device's SSH console (cap_ssh, key-authenticated):
call platform_configure {"secret":"<the printed line>"}
```
Both run as the local console caller, which is why the root-only `platform_configure` is allowed there and nowhere remote.
Why not chat: a message to the agent is sent to your LLM provider, i.e. the secret would leave your network. `platform_configure` is root-only, so it is
unreachable over MQTT by design. Treat the printed line like a password (clear your terminal afterwards).

## 4. Run the probe
```bash
cd apps/backend
MQTT_URL='mqtts://user:pass@broker:8883' PLATFORM_MASTER_KEY=<your key> \
  pnpm run device:probe <device_id> [base_topic]          # base_topic defaults to "espclaw"
```
Expected output — **every line PASS**:
```
PASS  1 plain path denies a root-only tool
PASS  2 valid token, read-only target
PASS  3 replayed token is refused
PASS  4 tampered signature is refused
PASS  5 token for another device is refused
PASS  6 target outside the device allow-list is refused
PASS  7 expired token is refused
RESULT: the device behaved exactly as designed.
```
| Symptom | Meaning / fix |
|---|---|
| exit 2, "no response from device" | device offline, wrong `base_topic`, or `MQTT_URL` cannot reach the broker |
| check 1 FAIL | the plain MQTT path let a root-only tool through — **stop and report**: the bridge hardening is not in this firmware |
| check 2 FAIL `platform secret not configured` | §3 was not done (or `cap_platform` not built in) |
| check 2 FAIL `invalid token signature` | the device holds a different secret: master key mismatch, or the wrong device id |
| check 2 FAIL `system time not set` | the device has no SNTP time yet; wait for Wi-Fi/time sync |
| check 2 FAIL `token expired or not yet valid` | the device clock is more than ~30 s off — fix time sync |
| check 3 FAIL | replay window not working on the device |
| check 6 FAIL | the device accepted a target outside its allow-list — **stop and report** |
| check 7 FAIL | the device does not enforce the TTL/clock check |

## 5. Then the same through the platform
Start the backend (`.env` with `MQTT_URL`, `PLATFORM_MASTER_KEY`, `JWT_SECRET`, and a first admin), log in as admin, and:
```bash
curl -X POST localhost:3000/v1/devices/<device_id>/privileged \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"capability":"list_agents","input":{}}'
```
Expect `command.status: "succeeded"` and, in `GET /v1/audit/events?device_id=<id>`, `device.command.created/completed` plus a
`security.privileged.executed` event naming your admin. `GET /v1/devices/<id>/commands` must show `platform_exec:list_agents` and **no token**.

Do **not** try `ota_update` until you have a firmware image served over HTTPS whose SHA-256 you have computed (`sha256sum app.bin`); the platform refuses an OTA without it.

## 6. Undo
* Remove the capability: rebuild without `CONFIG_APP_CLAW_CAP_PLATFORM` and flash the app (the stored secret becomes inert).
* Replace/rotate the secret: repeat §3 with the new master key (rotation means re-provisioning every device).

## 7. What to send back
The full probe output (it contains no secrets) and, if any check failed, the device's serial log around the failing check.
