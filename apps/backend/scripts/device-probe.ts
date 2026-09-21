/**
 * End-to-end probe of the device's `platform_exec` trust path, run from your workstation straight
 * against the MQTT broker and ONE device — no backend needed. Every check is read-only or a
 * deliberate refusal: nothing here changes device configuration or firmware.
 *
 *   MQTT_URL=mqtts://user:pass@broker:8883 PLATFORM_MASTER_KEY=... \
 *     pnpm --filter @esp-claw/backend device:probe <device_id> [base_topic]
 *
 * Prerequisites (docs/architecture/STAGE2-RBAC-AND-PROVISIONING.md §2.4): the device runs firmware
 * built with CONFIG_APP_CLAW_CAP_PLATFORM=y, is online on that broker, and was provisioned with the
 * secret printed by `platform:secret <device_id>` (platform_configure, run locally on the device).
 *
 * Checks (what each one proves about the REAL firmware):
 *   1 plain path denies a root-only tool         ota_update sent as a normal capability is refused (baseline still holds)
 *   2 valid token, read-only target              list_agents through platform_exec succeeds        (signature, TTL, clock, device id, allow-list)
 *   3 replayed token                             the same token again is refused                   (nonce window)
 *   4 tampered signature                         refused                                           (HMAC check)
 *   5 token for another device id                refused                                           (device binding)
 *   6 target outside the device allow-list       ssh_configure refused even with a valid signature (allow-list on the device)
 *   7 expired token                              a token that expired 2 minutes ago is refused     (TTL + clock)
 * Exit code 0 = every check behaved as designed; 1 = at least one did not; 2 = usage / setup error.
 */
import { createHmac, randomBytes, randomUUID } from "crypto";
import {
  TOKEN_TTL_SECONDS,
  deriveDeviceSecret,
  fromBase64Url,
  signPlatformToken,
  toBase64Url,
} from "../src/provisioning/platform-exec";

/** The little of an MQTT client the probe needs, so it can be tested without a network. */
export interface ProbeTransport {
  /** Publish a command JSON to the device and resolve with the matching response (by id), or reject on timeout. */
  request(command: Record<string, unknown>, timeoutMs: number): Promise<{ id: string; ok: boolean; result?: string }>;
}

export interface CheckResult {
  name: string;
  pass: boolean;
  detail: string;
}

export interface ProbeOptions {
  deviceId: string;
  masterKey: Buffer;
  transport: ProbeTransport;
  /** Unix seconds; injectable for tests. */
  now?: () => number;
  timeoutMs?: number;
}

const cmd = (name: string, input: Record<string, unknown>) => ({ id: randomUUID(), action: "capability", name, input });

/** Signs an arbitrary payload exactly like the platform does, for the negative checks that must bypass the signer's own guards. */
function forgeToken(secret: Buffer, payload: Record<string, unknown>): string {
  const segment = toBase64Url(Buffer.from(JSON.stringify(payload), "utf8"));
  return `${segment}.${toBase64Url(createHmac("sha256", secret).update(segment, "ascii").digest())}`;
}

export async function runDeviceProbe(opts: ProbeOptions): Promise<CheckResult[]> {
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const secret = deriveDeviceSecret(opts.masterKey, opts.deviceId);
  const results: CheckResult[] = [];

  const send = async (name: string, input: Record<string, unknown>) => opts.transport.request(cmd(name, input), timeoutMs);
  const viaToken = (token: string) => send("platform_exec", { token });
  const check = (name: string, pass: boolean, detail: string) => results.push({ name, pass, detail: detail.slice(0, 200) });
  const refusedWith = (r: { ok: boolean; result?: string }, pattern: RegExp) => !r.ok && pattern.test(r.result ?? "");

  // 1 ─ the baseline protection is still in force
  const plain = await send("ota_update", { url: "https://example.invalid/x.bin" });
  check("1 plain path denies a root-only tool", refusedWith(plain, /not exposed to the LLM/), plain.result ?? "");

  // 2 ─ a valid, read-only privileged call
  const good = signPlatformToken({ secret, deviceId: opts.deviceId, capability: "list_agents", input: {}, nowSeconds: now() });
  const ok = await viaToken(good.token);
  check("2 valid token, read-only target", ok.ok, ok.result ?? "");

  // 3 ─ replay
  const replay = await viaToken(good.token);
  check("3 replayed token is refused", refusedWith(replay, /nonce already used|replay/i), replay.result ?? "");

  // 4 ─ tampered signature
  const fresh = signPlatformToken({ secret, deviceId: opts.deviceId, capability: "list_agents", input: {}, nowSeconds: now() });
  const [seg, sig] = fresh.token.split(".");
  const tampered = await viaToken(`${seg}.${sig.slice(0, -2)}${sig.endsWith("AA") ? "BB" : "AA"}`);
  check("4 tampered signature is refused", refusedWith(tampered, /invalid token signature/i), tampered.result ?? "");

  // 5 ─ bound to another device
  const otherId = opts.deviceId === "000000000001" ? "000000000002" : "000000000001";
  const wrongDevice = signPlatformToken({ secret, deviceId: otherId, capability: "list_agents", input: {}, nowSeconds: now() });
  const wd = await viaToken(wrongDevice.token);
  check("5 token for another device is refused", refusedWith(wd, /different device/i), wd.result ?? "");

  // 6 ─ valid signature, target not on the device allow-list (the platform's signer would refuse to build this)
  const t = now() - 25;
  const notAllowed = forgeToken(secret, {
    device_id: opts.deviceId,
    capability: "ssh_configure",
    input: {},
    issued_at: t,
    expires_at: t + TOKEN_TTL_SECONDS,
    nonce: toBase64Url(randomBytes(16)),
  });
  const na = await viaToken(notAllowed);
  check("6 target outside the device allow-list is refused", refusedWith(na, /cannot be triggered through platform_exec/i), na.result ?? "");

  // 7 ─ expired
  const old = now() - 180;
  const expired = forgeToken(secret, {
    device_id: opts.deviceId,
    capability: "list_agents",
    input: {},
    issued_at: old,
    expires_at: old + TOKEN_TTL_SECONDS,
    nonce: toBase64Url(randomBytes(16)),
  });
  const ex = await viaToken(expired);
  check("7 expired token is refused", refusedWith(ex, /expired or not yet valid/i), ex.result ?? "");

  return results;
}

export function formatReport(results: CheckResult[]): string {
  const lines = results.map((r) => `${r.pass ? "PASS" : "FAIL"}  ${r.name}${r.pass ? "" : `  —  ${r.detail}`}`);
  const failed = results.filter((r) => !r.pass).length;
  lines.push("", failed === 0 ? "RESULT: the device behaved exactly as designed." : `RESULT: ${failed} check(s) did not behave as designed.`);
  return lines.join("\n");
}

// ───────────────────────────────────────────────────────── CLI ─────────────────────────────────────────────────────────
async function main(): Promise<number> {
  const [deviceId, baseTopic = "espclaw"] = process.argv.slice(2);
  const url = process.env.MQTT_URL;
  const master = process.env.PLATFORM_MASTER_KEY;
  if (!deviceId || !/^[0-9a-f]{12}$/.test(deviceId) || !url || !master) {
    console.error("usage: MQTT_URL=... PLATFORM_MASTER_KEY=... device:probe <device_id> [base_topic]");
    console.error("       device_id = 12 lowercase hex characters; MQTT_URL and PLATFORM_MASTER_KEY must be set");
    return 2;
  }
  const { default: mqtt } = await import("mqtt");
  const client = mqtt.connect(url, { clientId: `esp-claw-probe-${randomUUID().slice(0, 8)}`, reconnectPeriod: 0 });
  await new Promise<void>((resolve, reject) => {
    client.once("connect", () => resolve());
    client.once("error", reject);
  });
  const commandTopic = `${baseTopic}/${deviceId}/command`;
  const responseTopic = `${baseTopic}/${deviceId}/response`;
  await new Promise<void>((resolve, reject) => client.subscribe(responseTopic, { qos: 1 }, (e) => (e ? reject(e) : resolve())));

  const pending = new Map<string, (r: { id: string; ok: boolean; result?: string }) => void>();
  client.on("message", (_t, payload) => {
    try {
      const r = JSON.parse(payload.toString("utf8"));
      pending.get(r.id)?.(r);
    } catch {
      /* not JSON — ignore */
    }
  });
  const transport: ProbeTransport = {
    request: (command, timeoutMs) =>
      new Promise((resolve, reject) => {
        const id = command.id as string;
        const timer = setTimeout(() => (pending.delete(id), reject(new Error(`no response from ${deviceId} within ${timeoutMs} ms`))), timeoutMs);
        pending.set(id, (r) => (clearTimeout(timer), pending.delete(id), resolve(r)));
        client.publish(commandTopic, JSON.stringify(command), { qos: 1 });
      }),
  };

  try {
    const results = await runDeviceProbe({ deviceId, masterKey: fromBase64Url(master), transport });
    console.log(formatReport(results));
    return results.every((r) => r.pass) ? 0 : 1;
  } catch (err) {
    console.error(`probe aborted: ${(err as Error).message}`);
    console.error("Is the device online, provisioned (platform_configure) and running firmware with cap_platform enabled?");
    return 2;
  } finally {
    client.end(true);
  }
}

if (require.main === module) {
  void main().then((code) => process.exit(code));
}
