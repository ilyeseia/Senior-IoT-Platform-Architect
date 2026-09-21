/**
 * Prints the signing secret to install on ONE device so it accepts platform_exec tokens
 * (docs/architecture/STAGE2-RBAC-AND-PROVISIONING.md §3):
 *
 *   PLATFORM_MASTER_KEY=... pnpm --filter @esp-claw/backend platform:secret <device_id>
 *
 * Then, on the device itself (console, local web chat or Telegram as its owner — never over MQTT):
 *   platform_configure {"secret": "<the value printed here>"}
 *
 * The secret is derived from the master key and the device id (HKDF-SHA256); nothing is stored.
 * Treat the output like a password: do not paste it into tickets or chats, and clear your terminal.
 */
import "dotenv/config";
import { deriveDeviceSecret, fromBase64Url, toBase64Url } from "../src/provisioning/platform-exec";

const deviceId = process.argv[2];
const master = process.env.PLATFORM_MASTER_KEY;

if (!deviceId || !/^[0-9a-f]{12}$/.test(deviceId)) {
  console.error("usage: platform:secret <device_id>   (12 lowercase hex characters, e.g. ecda3b4ff7d4)");
  process.exit(2);
}
if (!master) {
  console.error("PLATFORM_MASTER_KEY is not set (see .env.example)");
  process.exit(2);
}
process.stdout.write(toBase64Url(deriveDeviceSecret(fromBase64Url(master), deviceId)) + "\n");
