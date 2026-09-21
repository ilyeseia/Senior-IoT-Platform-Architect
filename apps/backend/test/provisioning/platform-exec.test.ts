import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHmac } from "crypto";
import {
  DEVICE_SECRET_BYTES,
  ISSUED_AT_BACKDATE_SECONDS,
  PLATFORM_EXEC_TARGETS,
  PlatformTokenError,
  TOKEN_TTL_SECONDS,
  deriveDeviceSecret,
  fromBase64Url,
  redactSecrets,
  signPlatformToken,
  toBase64Url,
  validatePrivilegedInput,
} from "../../src/provisioning/platform-exec";
import { FirmwareModel } from "../helpers/firmware-verifier";

const DEVICE = "ecda3b4ff7d4";
const NOW = 1_800_000_000;
const OTA_INPUT = { url: "https://fw.example/app.bin", sha256: "ab".repeat(32) };
const secret = (n = 0) => Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1 + n));

describe("known-answer vectors (computed with independent tools, not with this code)", () => {
  it("HMAC-SHA256 over the ASCII base64url segment, keyed with the raw secret bytes (openssl)", () => {
    // openssl dgst -sha256 -mac HMAC -macopt hexkey:0102..20 over the text below
    const segment = "eyJkZXZpY2VfaWQiOiJhYmMifQ";
    const expected = "Htjg8TGQs1zedQ4iAaubZrHsW7ELPAkd9FZyTaiqlxs";
    expect(toBase64Url(createHmac("sha256", secret()).update(segment, "ascii").digest())).toBe(expected);
    // and the firmware model accepts exactly that signature (fails LATER, on the missing capability)
    const model = new FirmwareModel(secret(), "abc");
    expect(model.verify(`${segment}.${expected}`, NOW)).toEqual({ ok: false, error: "Error: token missing target capability" });
  });

  it("HKDF-SHA256(master, salt='esp-claw/platform_exec/v1', info=device_id) (openssl kdf)", () => {
    const master = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
    expect(deriveDeviceSecret(master, DEVICE).toString("hex")).toBe(
      "77b9eebd18218f3925be7abe3748db3872a8d737f674b2d14661909976d75a61",
    );
  });

  it("a whole token, byte for byte, equals the one built by an independent Python + openssl implementation", () => {
    const { token } = signPlatformToken({
      secret: secret(),
      deviceId: DEVICE,
      capability: "ota_update",
      input: OTA_INPUT,
      nowSeconds: NOW,
      nonce: "AAAAAAAAAAAAAAAAAAAAAA",
    });
    expect(token).toBe(
      "eyJkZXZpY2VfaWQiOiJlY2RhM2I0ZmY3ZDQiLCJjYXBhYmlsaXR5Ijoib3RhX3VwZGF0ZSIsImlucHV0Ijp7InVybCI6Imh0dHBzOi8vZncuZXhhbXBsZS9hcHAuYmluIiwic2hhMjU2IjoiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYiJ9LCJpc3N1ZWRfYXQiOjE3OTk5OTk5NzUsImV4cGlyZXNfYXQiOjE4MDAwMDAwMzUsIm5vbmNlIjoiQUFBQUFBQUFBQUFBQUFBQUFBQUFBQSJ9.zaBVdvOU_xAc5_tNyQPqyraUnFeVBb7JGkp7cxmf7C8",
    );
  });
});

describe("device secret derivation", () => {
  const master = secret(100);

  it("is deterministic, 32 bytes, and different for every device", () => {
    const a = deriveDeviceSecret(master, "aaaaaaaaaaaa");
    expect(a).toHaveLength(DEVICE_SECRET_BYTES);
    expect(deriveDeviceSecret(master, "aaaaaaaaaaaa").equals(a)).toBe(true);
    expect(deriveDeviceSecret(master, "bbbbbbbbbbbb").equals(a)).toBe(false);
  });

  it("depends on the master key", () => {
    expect(deriveDeviceSecret(secret(1), DEVICE).equals(deriveDeviceSecret(secret(2), DEVICE))).toBe(false);
  });

  it("never equals (or contains) the master key", () => {
    const s = deriveDeviceSecret(master, DEVICE);
    expect(s.equals(master)).toBe(false);
    expect(s.toString("hex")).not.toContain(master.toString("hex"));
  });

  it("refuses a short master key or an empty device id", () => {
    expect(() => deriveDeviceSecret(Buffer.alloc(31), DEVICE)).toThrow(/at least 32 bytes/);
    expect(() => deriveDeviceSecret(master, "")).toThrow(/deviceId is required/);
  });
});

describe("what the platform signs is what the firmware accepts", () => {
  const sign = (over: Partial<Parameters<typeof signPlatformToken>[0]> = {}) =>
    signPlatformToken({ secret: secret(), deviceId: DEVICE, capability: "ota_update", input: OTA_INPUT, nowSeconds: NOW, ...over });
  const device = (s = secret()) => new FirmwareModel(s, DEVICE);

  it("a fresh token verifies and yields the capability and input", () => {
    expect(device().verify(sign().token, NOW)).toEqual({ ok: true, capability: "ota_update", input: OTA_INPUT });
  });

  it.each([...PLATFORM_EXEC_TARGETS])("every allowed target (%s) is accepted", (capability) => {
    const input = capability === "ota_update" ? OTA_INPUT : { a: 1 };
    expect(device().verify(sign({ capability, input }).token, NOW)).toMatchObject({ ok: true, capability });
  });

  it("is single use: the same token twice is a replay", () => {
    const d = device();
    const { token } = sign();
    expect(d.verify(token, NOW).ok).toBe(true);
    expect(d.verify(token, NOW)).toEqual({ ok: false, error: "Error: token nonce already used (replay)" });
  });

  it("every token gets a fresh nonce, so two tokens for the same operation both verify", () => {
    const d = device();
    expect(d.verify(sign().token, NOW).ok).toBe(true);
    expect(d.verify(sign().token, NOW).ok).toBe(true);
  });

  it("a wrong secret fails the signature check", () => {
    expect(device(secret(9)).verify(sign().token, NOW)).toEqual({ ok: false, error: "Error: invalid token signature" });
  });

  it("a token for another device is refused", () => {
    expect(new FirmwareModel(secret(), "000000000001").verify(sign().token, NOW)).toEqual({
      ok: false,
      error: "Error: token was issued for a different device",
    });
  });

  it("a tampered payload or signature is refused", () => {
    const { token } = sign();
    const [p, s] = token.split(".");
    const tamperedPayload = `${p.slice(0, 10)}${p[10] === "A" ? "B" : "A"}${p.slice(11)}.${s}`;
    expect(device().verify(tamperedPayload, NOW)).toEqual({ ok: false, error: "Error: invalid token signature" });
    const tamperedSig = `${p}.${s.slice(0, -2)}${s.endsWith("AA") ? "BB" : "AA"}`;
    expect(device().verify(tamperedSig, NOW)).toEqual({ ok: false, error: "Error: invalid token signature" });
  });

  it("an input swapped after signing is refused (the input is inside the signed payload)", () => {
    const a = sign({ input: OTA_INPUT }).token;
    const b = sign({ input: { url: "https://evil.example/x.bin", sha256: "cd".repeat(32) } }).token;
    const forged = `${b.split(".")[0]}.${a.split(".")[1]}`;
    expect(device().verify(forged, NOW)).toEqual({ ok: false, error: "Error: invalid token signature" });
  });

  it("is valid for about a minute and not after", () => {
    const { token } = sign(); // issued_at = NOW - 25, expires_at = NOW + 35
    expect(device().verify(token, NOW + 35).ok).toBe(true);
    expect(device().verify(token, NOW + 36)).toEqual({ ok: false, error: "Error: token expired or not yet valid" });
  });

  it("tolerates a device clock ±30 s away (backdated issued_at makes the skew symmetric)", () => {
    const { token } = sign();
    expect(device().verify(token, NOW - 30).ok).toBe(true); // device 30 s behind
    expect(device().verify(token, NOW + 30).ok).toBe(true); // device 30 s ahead
    expect(device().verify(token, NOW - 31).ok).toBe(false);
  });

  it("without the backdate, a device only 6 s behind would reject every token (why it exists)", () => {
    expect(ISSUED_AT_BACKDATE_SECONDS).toBeGreaterThan(5);
    const t = NOW - ISSUED_AT_BACKDATE_SECONDS; // the token's issued_at
    // a naive issuer would use issued_at = NOW; the device requires now >= issued_at - 5
    expect(NOW - 6 < NOW - 5).toBe(true);
    expect(t).toBe(NOW - 25);
  });

  it("stamps a 60 s window and never more than the device allows", () => {
    const { payload } = sign();
    expect(payload.expires_at - payload.issued_at).toBe(TOKEN_TTL_SECONDS);
    expect(payload.issued_at).toBe(NOW - ISSUED_AT_BACKDATE_SECONDS);
  });

  it("a device without a clock (before SNTP) refuses to trust any token", () => {
    expect(device().verify(sign().token, 1000)).toEqual({ ok: false, error: "Error: system time not set; cannot verify token expiry" });
  });

  it("a device that was never provisioned refuses", () => {
    expect(new FirmwareModel(null, DEVICE).verify(sign().token, NOW)).toEqual({
      ok: false,
      error: "Error: platform secret not configured (run platform_configure locally first)",
    });
  });

  it("documents the residual risk: a reboot clears the replay window, so only the TTL protects then", () => {
    const d = device();
    const { token } = sign();
    expect(d.verify(token, NOW).ok).toBe(true);
    d.reboot();
    expect(d.verify(token, NOW + 1).ok).toBe(true); // replayed after reboot, still inside the window
    expect(d.verify(token, NOW + 60).ok).toBe(false); // but not after it
  });
});

describe("targets and size limits", () => {
  const sign = (capability: string, input: Record<string, unknown> = {}) =>
    signPlatformToken({ secret: secret(), deviceId: DEVICE, capability, input, nowSeconds: NOW });

  it.each(["platform_exec", "platform_configure", "ssh_configure", "delete_agent", "write_file", "lua_run_script", ""])(
    "refuses to sign a token for %s",
    (capability) => {
      expect(() => sign(capability)).toThrow(PlatformTokenError);
    },
  );

  it("refuses an input that would overflow the device's payload buffer, before signing", () => {
    expect(() => sign("mqtt_configure", { blob: "x".repeat(700) })).toThrow(/too large/);
  });

  it("accepts a large but legal mqtt_configure", () => {
    const input = { enabled: true, broker: "broker.example.com", port: 8883, tls: true, username: "u".repeat(30), password: "p".repeat(40), client_id: "c".repeat(30), base_topic: "espclaw/tenant" };
    const { token } = sign("mqtt_configure", input);
    expect(new FirmwareModel(secret(), DEVICE).verify(token, NOW)).toMatchObject({ ok: true, capability: "mqtt_configure" });
  });

  it("the token stays within the device's segment limit at the largest accepted input", () => {
    const { token } = sign("mqtt_configure", { blob: "x".repeat(480) });
    expect(token.split(".")[0].length).toBeLessThanOrEqual(1024);
  });
});

describe("input validation before signing", () => {
  it("ota_update requires an https url and the image digest", () => {
    expect(() => validatePrivilegedInput("ota_update", { url: "https://fw.example/a.bin", sha256: "ab".repeat(32) })).not.toThrow();
    expect(() => validatePrivilegedInput("ota_update", { url: "http://fw.example/a.bin", sha256: "ab".repeat(32) })).toThrow(/https/);
    expect(() => validatePrivilegedInput("ota_update", { sha256: "ab".repeat(32) })).toThrow(/https/);
    expect(() => validatePrivilegedInput("ota_update", { url: "https://fw.example/a.bin" })).toThrow(/sha256/);
    expect(() => validatePrivilegedInput("ota_update", { url: "https://fw.example/a.bin", sha256: "xyz" })).toThrow(/sha256/);
    expect(() => validatePrivilegedInput("ota_update", { url: "https://" + "a".repeat(600), sha256: "ab".repeat(32) })).toThrow(/512/);
  });

  it("other capabilities are not constrained by the platform (the device validates them)", () => {
    expect(() => validatePrivilegedInput("mqtt_configure", {})).not.toThrow();
    expect(() => validatePrivilegedInput("list_agents", {})).not.toThrow();
  });
});

describe("redactSecrets", () => {
  it("hides credential-looking fields at any depth and leaves the rest", () => {
    const input = {
      broker: "b.example.com",
      port: 8883,
      password: "hunter2",
      mqtt_password: "hunter2",
      wg_private_key: "abc",
      api_key: "k",
      nested: { secret: "s", psk: "p", ok: 1 },
      list: [{ token: "t", name: "n" }],
    };
    const r = redactSecrets(input) as Record<string, unknown>;
    expect(r).toEqual({
      broker: "b.example.com",
      port: 8883,
      password: "[redacted]",
      mqtt_password: "[redacted]",
      wg_private_key: "[redacted]",
      api_key: "[redacted]",
      nested: { secret: "[redacted]", psk: "[redacted]", ok: 1 },
      list: [{ token: "[redacted]", name: "n" }],
    });
    expect(JSON.stringify(r)).not.toContain("hunter2");
    expect(input.password).toBe("hunter2"); // the original is untouched
  });
});

describe("base64url helpers", () => {
  it("round-trips and rejects non-base64url text", () => {
    const bytes = Buffer.from([251, 255, 254, 0, 1, 2]);
    expect(toBase64Url(bytes)).toBe("-__-AAEC");
    expect(fromBase64Url("-__-AAEC").equals(bytes)).toBe(true);
    expect(() => fromBase64Url("not base64!")).toThrow();
  });
});

describe("allow-list drift against the firmware source (only when the sibling repository is present)", () => {
  const cSource = resolve(__dirname, "../../../../../esp-claw-2/components/claw_capabilities/cap_platform/src/cap_platform.c");
  it.skipIf(!existsSync(cSource))("PLATFORM_EXEC_TARGETS equals s_platform_allowed_targets in cap_platform.c", () => {
    const text = readFileSync(cSource, "utf8");
    const block = /s_platform_allowed_targets\[\]\s*=\s*\{([^}]*)\}/.exec(text)?.[1] ?? "";
    const inFirmware = [...block.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    expect([...inFirmware].sort()).toEqual([...PLATFORM_EXEC_TARGETS].sort());
  });
});
