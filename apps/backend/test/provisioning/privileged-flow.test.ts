import { beforeEach, describe, expect, it, vi } from "vitest";
import { BadRequestException, ServiceUnavailableException, UnprocessableEntityException } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import type { Repository } from "typeorm";
import { CommandsService } from "../../src/commands/commands.service";
import type { Command } from "../../src/commands/command.entity";
import type { CommandResult } from "../../src/commands/command-result.entity";
import type { MqttService } from "../../src/mqtt";
import type { DevicesService } from "../../src/devices";
import { PlatformTokenService } from "../../src/provisioning/platform-token.service";
import { PrivilegedCommandsService } from "../../src/provisioning/privileged-commands.service";
import { ProvisioningController } from "../../src/provisioning/provisioning.controller";
import { deriveDeviceSecret, fromBase64Url, toBase64Url } from "../../src/provisioning/platform-exec";
import type { Env } from "../../src/config/env.validation";
import { FirmwareModel } from "../helpers/firmware-verifier";
import { RecordingEventBus } from "../helpers/recording-bus";

const DEVICE = "ecda3b4ff7d4";
const MASTER = toBase64Url(Buffer.from(Array.from({ length: 32 }, (_, i) => 200 - i)));
const NOW = 1_800_000_000;
const OTA = { url: "https://fw.example/app.bin", sha256: "ab".repeat(32) };

function config(master: string | undefined) {
  return { get: () => master } as unknown as ConfigService<Env, true>;
}

/**
 * The whole path except the network: real controller, services and CommandsService; the "device"
 * is FirmwareModel (a port of cap_platform.c) behind a stand-in for MqttService.sendCommand.
 */
function build(opts: { master?: string | undefined; deviceSecretFrom?: string } = {}) {
  const master = "master" in opts ? opts.master : MASTER;
  const tokens = new PlatformTokenService(config(master));
  tokens.now = () => NOW;

  const provisioned = opts.deviceSecretFrom ?? master;
  const model = new FirmwareModel(provisioned ? deriveDeviceSecret(fromBase64Url(provisioned), DEVICE) : null, DEVICE);
  const wire: { name: string; input?: Record<string, unknown> }[] = [];
  const mqtt = {
    sendCommand: vi.fn(async (_id: string, cmd: { name: string; input?: Record<string, unknown> }, o: { id: string }) => {
      wire.push(cmd);
      const r = model.verify(cmd.input?.token as string | undefined, NOW);
      return r.ok
        ? { id: o.id, capability: cmd.name, ok: true, result: `{"ok":true,"ran":"${r.capability}"}` }
        : { id: o.id, capability: cmd.name, ok: false, result: r.error };
    }),
  };

  const saved: Command[] = [];
  const commandsRepo = {
    create: (v: Partial<Command>) => ({ ...v }) as Command,
    save: vi.fn(async (v: Command) => (saved.push({ ...v }), v)),
    update: vi.fn(),
    find: vi.fn(),
  };
  const resultsRepo = { create: (v: Partial<CommandResult>) => ({ ...v }) as CommandResult, save: vi.fn(async (v: CommandResult) => v) };
  const devices = { findOne: vi.fn(async () => ({ id: DEVICE, baseTopic: "espclaw" })) };
  const bus = new RecordingEventBus();
  const commands = new CommandsService(
    commandsRepo as unknown as Repository<Command>,
    resultsRepo as unknown as Repository<CommandResult>,
    mqtt as unknown as MqttService,
    devices as unknown as DevicesService,
    bus,
  );
  const privileged = new PrivilegedCommandsService(tokens, commands, bus);
  const controller = new ProvisioningController(privileged, tokens);
  return { tokens, controller, privileged, mqtt, wire, saved, bus, model };
}

const asAdmin = { user: { sub: "admin-1" } };

describe("privileged execution, end to end against the firmware model", () => {
  let ctx: ReturnType<typeof build>;
  beforeEach(() => {
    ctx = build();
  });

  it("runs an allowed capability: the device verifies the token and executes the target", async () => {
    const outcome = await ctx.controller.execute(DEVICE, { capability: "ota_update", input: OTA }, asAdmin);
    expect(outcome.command.status).toBe("succeeded");
    expect(outcome.result.result).toContain('"ran":"ota_update"');
    expect(ctx.wire).toHaveLength(1);
    expect(ctx.wire[0].name).toBe("platform_exec"); // on the wire it is platform_exec + a token…
    expect(Object.keys(ctx.wire[0].input ?? {})).toEqual(["token"]);
  });

  it("stores and announces the LOGICAL operation with secrets redacted — never the token, never a password", async () => {
    const input = { enabled: true, broker: "b.example.com", port: 8883, username: "dev", password: "hunter2-secret" };
    const outcome = await ctx.controller.execute(DEVICE, { capability: "mqtt_configure", input }, asAdmin);

    expect(outcome.command.name).toBe("platform_exec:mqtt_configure");
    expect(outcome.command.input).toMatchObject({ broker: "b.example.com", password: "[redacted]" });

    const token = ctx.wire[0].input!.token as string;
    const everything = JSON.stringify({ saved: ctx.saved, events: ctx.bus.events, outcome });
    expect(everything).not.toContain(token);
    expect(everything).not.toContain(token.split(".")[0]);
    expect(everything).not.toContain("hunter2-secret");
    // …but the device DID receive the real password inside the (signed) token payload
    const payload = JSON.parse(fromBase64Url(token.split(".")[0]).toString("utf8"));
    expect(payload.input.password).toBe("hunter2-secret");
  });

  it("publishes an audited security event naming the actor, with no input in it", async () => {
    const outcome = await ctx.controller.execute(DEVICE, { capability: "ota_update", input: OTA }, asAdmin);
    const [event] = ctx.bus.ofType("security.privileged.executed");
    expect(event).toMatchObject({
      device_id: DEVICE,
      source: "module:provisioning",
      causation_id: outcome.command.id,
      payload: { commandId: outcome.command.id, capability: "ota_update", actor: "admin-1", status: "succeeded" },
    });
    expect(JSON.stringify(event)).not.toContain(OTA.sha256);
    // the audit trail also gets the command lifecycle, under the logical name
    expect(ctx.bus.ofType("device.command.created")[0].payload).toMatchObject({ name: "platform_exec:ota_update" });
  });

  it("every execution gets its own single-use token (running it twice both succeed)", async () => {
    const a = await ctx.controller.execute(DEVICE, { capability: "list_agents", input: {} }, asAdmin);
    const b = await ctx.controller.execute(DEVICE, { capability: "list_agents", input: {} }, asAdmin);
    expect([a.command.status, b.command.status]).toEqual(["succeeded", "succeeded"]);
    expect(ctx.wire[0].input!.token).not.toBe(ctx.wire[1].input!.token);
  });

  it("a device that holds a different secret refuses, and the platform records it as rejected", async () => {
    const wrong = build({ deviceSecretFrom: toBase64Url(Buffer.alloc(32, 7)) });
    const outcome = await wrong.controller.execute(DEVICE, { capability: "list_agents", input: {} }, asAdmin);
    expect(outcome.command.status).toBe("rejected");
    expect(outcome.result.result).toBe("Error: invalid token signature");
    expect(wrong.bus.ofType("security.privileged.executed")[0].payload).toMatchObject({ status: "rejected" });
  });

  it("a device that was never provisioned is recorded as rejected, with the reason", async () => {
    // The platform has a master key, but nobody ran platform_configure on this device.
    const t = build();
    const unprovisioned = new FirmwareModel(null, DEVICE);
    t.mqtt.sendCommand.mockImplementationOnce(async (_i, cmd, o) => {
      const r = unprovisioned.verify(cmd.input?.token as string, NOW);
      return { id: o.id, ok: false, result: (r as { error: string }).error };
    });
    const outcome = await t.controller.execute(DEVICE, { capability: "list_agents", input: {} }, asAdmin);
    expect(outcome.command.status).toBe("rejected");
    expect(outcome.result.result).toMatch(/platform secret not configured/);
  });

  it("answers 503 without touching the device when no master key is configured", async () => {
    const off = build({ master: undefined });
    await expect(off.controller.execute(DEVICE, { capability: "list_agents", input: {} }, asAdmin)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(off.mqtt.sendCommand).not.toHaveBeenCalled();
    expect(off.controller.targets()).toMatchObject({ configured: false });
  });
});

describe("what is refused before anything is signed or sent", () => {
  const ctx = build();

  it.each([
    ["a capability outside the allow-list", { capability: "platform_configure", input: {} }],
    ["an unknown capability", { capability: "reboot", input: {} }],
    ["an unexpected field", { capability: "list_agents", input: {}, force: true }],
    ["a timeout out of range", { capability: "list_agents", input: {}, timeoutMs: 5 }],
    ["a non-object input", { capability: "list_agents", input: "x" }],
  ])("rejects %s (400)", (_l, body) => {
    expect(() => ctx.controller.execute(DEVICE, body, asAdmin)).toThrow(BadRequestException);
  });

  it("rejects an OTA without the image digest (400) — the platform never sends an unverified OTA", async () => {
    await expect(ctx.controller.execute(DEVICE, { capability: "ota_update", input: { url: OTA.url } }, asAdmin)).rejects.toThrow(/sha256/);
    await expect(
      ctx.controller.execute(DEVICE, { capability: "ota_update", input: { url: "http://x/a.bin", sha256: OTA.sha256 } }, asAdmin),
    ).rejects.toThrow(/https/);
    expect(ctx.mqtt.sendCommand).not.toHaveBeenCalled();
  });

  it("rejects an input too large for the device (422)", async () => {
    await expect(
      ctx.controller.execute(DEVICE, { capability: "mqtt_configure", input: { blob: "x".repeat(900) } }, asAdmin),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(ctx.mqtt.sendCommand).not.toHaveBeenCalled();
  });

  it("lists the allowed targets and whether signing is configured", () => {
    expect(ctx.controller.targets()).toMatchObject({ configured: true });
    expect(ctx.controller.targets().targets).toContain("ota_update");
    expect(ctx.controller.targets().targets).not.toContain("platform_configure");
  });
});

describe("PlatformTokenService", () => {
  it("derives the same secret the CLI prints and the device model is configured with", () => {
    const svc = new PlatformTokenService(config(MASTER));
    const printed = svc.deviceSecret(DEVICE);
    expect(fromBase64Url(printed).equals(deriveDeviceSecret(fromBase64Url(MASTER), DEVICE))).toBe(true);
    expect(svc.deviceSecret("000000000001")).not.toBe(printed);
  });

  it("refuses to derive or sign without a master key", () => {
    const svc = new PlatformTokenService(config(undefined));
    expect(svc.isConfigured()).toBe(false);
    expect(() => svc.deviceSecret(DEVICE)).toThrow(ServiceUnavailableException);
    expect(() => svc.issue(DEVICE, "list_agents", {})).toThrow(ServiceUnavailableException);
  });
});
