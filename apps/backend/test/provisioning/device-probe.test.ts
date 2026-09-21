import { describe, expect, it } from "vitest";
import { runDeviceProbe, formatReport } from "../../scripts/device-probe";
import type { ProbeTransport } from "../../scripts/device-probe";
import { deriveDeviceSecret } from "../../src/provisioning/platform-exec";
import { FirmwareModel } from "../helpers/firmware-verifier";

const DEVICE = "ecda3b4ff7d4";
const MASTER = Buffer.from(Array.from({ length: 32 }, (_, i) => 90 + i));
const NOW = 1_800_000_000;

/** A device made of the firmware model, including the plain-path denial of root-only tools. */
function deviceTransport(model: FirmwareModel): ProbeTransport {
  return {
    request: async (command) => {
      const id = command.id as string;
      const name = command.name as string;
      if (name === "platform_exec") {
        const r = model.verify((command.input as { token?: string }).token, NOW);
        return r.ok ? { id, ok: true, result: '{"agents":[]}' } : { id, ok: false, result: r.error };
      }
      return { id, ok: false, result: `Error: cap '${name}' is not exposed to the LLM (reason=root_agent_only).` };
    },
  };
}

const run = (transport: ProbeTransport) => runDeviceProbe({ deviceId: DEVICE, masterKey: MASTER, transport, now: () => NOW });

describe("device probe against a device that behaves as designed", () => {
  it("passes all seven checks", async () => {
    const results = await run(deviceTransport(new FirmwareModel(deriveDeviceSecret(MASTER, DEVICE), DEVICE)));
    expect(results.map((r) => [r.name, r.pass])).toEqual([
      ["1 plain path denies a root-only tool", true],
      ["2 valid token, read-only target", true],
      ["3 replayed token is refused", true],
      ["4 tampered signature is refused", true],
      ["5 token for another device is refused", true],
      ["6 target outside the device allow-list is refused", true],
      ["7 expired token is refused", true],
    ]);
    expect(formatReport(results)).toContain("the device behaved exactly as designed");
  });
});

describe("device probe detects a device that does NOT behave as designed", () => {
  it("fails check 2 (and reports why) when the device was never provisioned", async () => {
    const results = await run(deviceTransport(new FirmwareModel(null, DEVICE)));
    const c2 = results.find((r) => r.name.startsWith("2"))!;
    expect(c2.pass).toBe(false);
    expect(c2.detail).toMatch(/platform secret not configured/);
  });

  it("fails check 2 when the device holds a different secret", async () => {
    const results = await run(deviceTransport(new FirmwareModel(Buffer.alloc(32, 9), DEVICE)));
    expect(results.find((r) => r.name.startsWith("2"))!.pass).toBe(false);
  });

  it("fails check 3 when the device has no replay protection", async () => {
    class NoReplay extends FirmwareModel {
      override verify(token: string | undefined, now: number) {
        this.reboot(); // forget nonces before every call
        return super.verify(token, now);
      }
    }
    const results = await run(deviceTransport(new NoReplay(deriveDeviceSecret(MASTER, DEVICE), DEVICE)));
    expect(results.find((r) => r.name.startsWith("3"))!.pass).toBe(false);
    expect(formatReport(results)).toContain("did not behave as designed");
  });

  it("fails check 1 when the plain path lets a root-only tool through", async () => {
    const transport: ProbeTransport = { request: async (c) => ({ id: c.id as string, ok: true, result: "started" }) };
    const results = await run(transport);
    expect(results.find((r) => r.name.startsWith("1"))!.pass).toBe(false);
  });

  it("fails check 6 when the device accepts a target outside its allow-list", async () => {
    const lax: ProbeTransport = {
      request: async (command) => {
        const id = command.id as string;
        const token = (command.input as { token?: string })?.token;
        if (command.name === "platform_exec" && token) {
          const payload = JSON.parse(Buffer.from(token.split(".")[0].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
          if (payload.capability === "ssh_configure") return { id, ok: true, result: "ssh enabled" };
        }
        return deviceTransport(new FirmwareModel(deriveDeviceSecret(MASTER, DEVICE), DEVICE)).request(command, 1);
      },
    };
    expect((await run(lax)).find((r) => r.name.startsWith("6"))!.pass).toBe(false);
  });

  it("does not consider a timeout a pass: a transport failure propagates", async () => {
    const dead: ProbeTransport = { request: async () => Promise.reject(new Error("no response from device")) };
    await expect(run(dead)).rejects.toThrow(/no response/);
  });
});
