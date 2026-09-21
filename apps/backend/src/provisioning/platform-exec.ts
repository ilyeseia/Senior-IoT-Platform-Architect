import { createHmac, hkdfSync, randomBytes } from "crypto";

/**
 * The platform side of the device's `cap_platform` trust path (esp-claw-2/components/claw_capabilities/
 * cap_platform). A device only runs a root-only capability when it receives `platform_exec` with a
 * token it can verify against a secret provisioned once over a local channel. Everything here must
 * stay byte-compatible with cap_platform.c:
 *
 *   token   = base64url(payloadJSON) + "." + base64url(HMAC-SHA256(secret, ASCII bytes of the first segment))
 *   payload = { device_id, capability, input, issued_at, expires_at, nonce }          (times: Unix seconds)
 *
 * The signature covers the base64url TEXT (JWT style), so issuer and verifier never have to agree
 * on a JSON canonical form. The device enforces: matching device_id, capability in ITS allow-list,
 * expires_at - issued_at <= 60, a valid clock (>= 2024-01-01) and now within
 * [issued_at - 5, expires_at], a non-empty single-use nonce (<= 47 chars), and payload/segment size limits.
 */

/** Must equal `s_platform_allowed_targets` in cap_platform.c. The device is the authority; this list only fails fast. */
export const PLATFORM_EXEC_TARGETS = [
  "ota_update",
  "mqtt_configure",
  "network_configure",
  "vpn_configure",
  "vpn_connect",
  "vpn_disconnect",
  "wireguard_configure",
  "list_agents",
  "inspect_agent",
] as const;
export type PlatformExecTarget = (typeof PLATFORM_EXEC_TARGETS)[number];

export function isPlatformExecTarget(value: string): value is PlatformExecTarget {
  return (PLATFORM_EXEC_TARGETS as readonly string[]).includes(value);
}

/** cap_platform.c: CAP_PLATFORM_MAX_TOKEN_TTL_S, CAP_PLATFORM_SEGMENT_MAX, CAP_PLATFORM_PAYLOAD_MAX, CAP_PLATFORM_CLOCK_SKEW_S. */
export const TOKEN_TTL_SECONDS = 60;
export const SEGMENT_MAX_CHARS = 1024;
export const PAYLOAD_MAX_BYTES = 768;
export const DEVICE_CLOCK_SKEW_SECONDS = 5;
/**
 * Tokens are issued with `issued_at` this many seconds in the PAST. The device accepts a token only
 * while now ∈ [issued_at - 5, issued_at + 60]; issuing at "now" would reject any device whose clock
 * is more than 5 s behind ours, while one that is ahead has a whole minute of slack. Backdating by
 * 25 s makes the tolerance symmetric (≈ ±30 s) without lengthening the 60 s validity window.
 */
export const ISSUED_AT_BACKDATE_SECONDS = 25;
export const NONCE_BYTES = 16;

const HKDF_SALT = Buffer.from("esp-claw/platform_exec/v1", "utf8");
export const DEVICE_SECRET_BYTES = 32;
export const MIN_MASTER_KEY_BYTES = 32;

export function toBase64Url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(text: string): Buffer {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) {
    throw new Error("not base64url");
  }
  return Buffer.from(text.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/**
 * Per-device signing secret = HKDF-SHA256(master, salt = "esp-claw/platform_exec/v1", info = device_id).
 * Compromising one device therefore reveals only that device's secret, never the master key or a
 * sibling's secret, and the platform stores no per-device secret at all — it derives on demand.
 */
export function deriveDeviceSecret(masterKey: Buffer, deviceId: string): Buffer {
  if (masterKey.length < MIN_MASTER_KEY_BYTES) {
    throw new Error(`master key must be at least ${MIN_MASTER_KEY_BYTES} bytes`);
  }
  if (!deviceId) {
    throw new Error("deviceId is required");
  }
  return Buffer.from(hkdfSync("sha256", masterKey, HKDF_SALT, Buffer.from(deviceId, "utf8"), DEVICE_SECRET_BYTES));
}

export class PlatformTokenError extends Error {
  constructor(
    message: string,
    readonly kind: "invalid_target" | "invalid_input" | "too_large",
  ) {
    super(message);
  }
}

export interface SignInput {
  secret: Buffer;
  deviceId: string;
  capability: string;
  input: Record<string, unknown>;
  /** Unix seconds; injectable for tests. */
  nowSeconds?: number;
  /** Injectable for tests; defaults to 16 random bytes. */
  nonce?: string;
}

export interface SignedToken {
  token: string;
  payload: {
    device_id: string;
    capability: string;
    input: Record<string, unknown>;
    issued_at: number;
    expires_at: number;
    nonce: string;
  };
}

export function signPlatformToken(args: SignInput): SignedToken {
  if (!isPlatformExecTarget(args.capability)) {
    throw new PlatformTokenError(`"${args.capability}" cannot be triggered through platform_exec`, "invalid_target");
  }
  const now = args.nowSeconds ?? Math.floor(Date.now() / 1000);
  const issuedAt = now - ISSUED_AT_BACKDATE_SECONDS;
  const payload = {
    device_id: args.deviceId,
    capability: args.capability,
    input: args.input,
    issued_at: issuedAt,
    expires_at: issuedAt + TOKEN_TTL_SECONDS,
    nonce: args.nonce ?? toBase64Url(randomBytes(NONCE_BYTES)),
  };
  const payloadJson = Buffer.from(JSON.stringify(payload), "utf8");
  if (payloadJson.length > PAYLOAD_MAX_BYTES) {
    throw new PlatformTokenError(
      `input is too large for platform_exec (${payloadJson.length} bytes of token payload, the device accepts ${PAYLOAD_MAX_BYTES})`,
      "too_large",
    );
  }
  const payloadSegment = toBase64Url(payloadJson);
  if (payloadSegment.length > SEGMENT_MAX_CHARS) {
    throw new PlatformTokenError("input is too large for platform_exec (encoded payload exceeds the device limit)", "too_large");
  }
  const signature = toBase64Url(createHmac("sha256", args.secret).update(payloadSegment, "ascii").digest());
  return { token: `${payloadSegment}.${signature}`, payload };
}

const SECRET_KEY_PATTERN = /pass(word|wd)?|secret|token|private|api[_-]?key|psk|credential/i;

/**
 * Copy of `value` with secret-looking fields replaced. Used for what gets persisted and shown about
 * a privileged command: the device needs the real `mqtt_password`, the command history does not.
 */
export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactSecrets);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, SECRET_KEY_PATTERN.test(k) ? "[redacted]" : redactSecrets(v)]),
    );
  }
  return value;
}

/**
 * Input rules the platform enforces before signing anything (cheaper and safer than a device round
 * trip). `ota_update` must carry the expected image digest: the device verifies it before it
 * activates the new slot (esp-claw-2 commit bee5b35), so the platform must never send an OTA
 * without one.
 */
export function validatePrivilegedInput(capability: PlatformExecTarget, input: Record<string, unknown>): void {
  if (capability === "ota_update") {
    const url = input.url;
    if (typeof url !== "string" || !url.startsWith("https://") || url.length > 512) {
      throw new PlatformTokenError("ota_update needs an https:// url (at most 512 characters)", "invalid_input");
    }
    const sha = input.sha256;
    if (typeof sha !== "string" || !/^[0-9a-fA-F]{64}$/.test(sha)) {
      throw new PlatformTokenError("ota_update needs sha256: the 64-hex-character digest of the firmware image", "invalid_input");
    }
  }
}
