import { createHmac, timingSafeEqual } from "crypto";
import { PLATFORM_EXEC_TARGETS, fromBase64Url } from "../../src/provisioning/platform-exec";

/**
 * A line-by-line port of cap_platform_exec_execute() in
 * esp-claw-2/components/claw_capabilities/cap_platform/src/cap_platform.c — the device side of the
 * token. It exists so tests can prove that what the platform signs is what the firmware accepts,
 * and that everything the firmware rejects is rejected here for the same reason. It is a MODEL of
 * that C code, not the C code: a run against a real device is still the only end-to-end proof.
 *
 * Constants mirror the #defines in cap_platform.c.
 */
const SECRET_MIN_BYTES = 16;
const SEGMENT_MAX = 1024;
const PAYLOAD_MAX = 768;
const NONCE_WINDOW = 16;
const MAX_TTL_S = 60;
const CLOCK_SKEW_S = 5;
const MIN_VALID_EPOCH = 1704067200;

export type VerifyResult = { ok: true; capability: string; input: unknown } | { ok: false; error: string };

export class FirmwareModel {
  private readonly seenNonces: string[] = [];

  constructor(
    private readonly secret: Buffer | null,
    private readonly ownDeviceId: string,
  ) {}

  verify(token: string | undefined, nowSeconds: number): VerifyResult {
    if (!this.secret || this.secret.length < SECRET_MIN_BYTES) {
      return fail("platform secret not configured (run platform_configure locally first)");
    }
    if (!token) return fail("'token' is required");

    const dot = token.indexOf(".");
    if (dot <= 0 || dot === token.length - 1) return fail("malformed token (expected <payload>.<sig>)");
    const payloadSegment = token.slice(0, dot);
    const sigSegment = token.slice(dot + 1);

    const sig = decode(sigSegment, 64);
    if (!sig || sig.length !== 32) return fail("malformed token signature");

    const computed = createHmac("sha256", this.secret).update(payloadSegment, "ascii").digest();
    if (!timingSafeEqual(computed, sig)) return fail("invalid token signature");

    const payloadBytes = decode(payloadSegment, PAYLOAD_MAX);
    if (!payloadBytes) return fail("malformed token payload encoding");
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(payloadBytes.toString("utf8"));
    } catch {
      return fail("token payload is not valid JSON");
    }

    const str = (k: string) => (typeof payload[k] === "string" ? (payload[k] as string) : null);
    const num = (k: string) => (typeof payload[k] === "number" ? (payload[k] as number) : -1);
    const deviceId = str("device_id");
    const capability = str("capability");
    const nonce = str("nonce");
    const issuedAt = num("issued_at");
    const expiresAt = num("expires_at");

    if (deviceId !== this.ownDeviceId) return fail("token was issued for a different device");
    if (!capability) return fail("token missing target capability");
    if (!(PLATFORM_EXEC_TARGETS as readonly string[]).includes(capability)) {
      return fail(`capability '${capability}' cannot be triggered through platform_exec`);
    }
    if (issuedAt < 0 || expiresAt < 0 || expiresAt <= issuedAt || expiresAt - issuedAt > MAX_TTL_S) {
      return fail(`invalid token validity window (must be issued_at < expires_at, TTL <= ${MAX_TTL_S}s)`);
    }
    if (nowSeconds < MIN_VALID_EPOCH) return fail("system time not set; cannot verify token expiry");
    if (nowSeconds < issuedAt - CLOCK_SKEW_S || nowSeconds > expiresAt) return fail("token expired or not yet valid");

    if (!nonce || this.seenNonces.includes(nonce)) return fail("token nonce already used (replay)");
    this.seenNonces.push(nonce.slice(0, 47)); // seen_nonces[..][48] in C
    if (this.seenNonces.length > NONCE_WINDOW) this.seenNonces.shift();

    return { ok: true, capability, input: payload.input ?? {} };
  }

  /** A device reboot loses the in-RAM replay window (audit S4-b). */
  reboot(): void {
    this.seenNonces.length = 0;
  }
}

function fail(error: string): VerifyResult {
  return { ok: false, error: `Error: ${error}` };
}

/** cap_platform_base64url_decode + its size checks; returns null where the C code returns an error. */
function decode(segment: string, maxDecoded: number): Buffer | null {
  if (segment.length === 0 || segment.length > SEGMENT_MAX) return null;
  let buf: Buffer;
  try {
    buf = fromBase64Url(segment);
  } catch {
    return null;
  }
  return buf.length > maxDecoded ? null : buf;
}
