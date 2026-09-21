import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotFoundException } from "@nestjs/common";
import type { Repository } from "typeorm";
import { CommandsService } from "../../src/commands/commands.service";
import type { Command } from "../../src/commands/command.entity";
import type { CommandResult } from "../../src/commands/command-result.entity";
import type { MqttService } from "../../src/mqtt/mqtt.service";
import type { DevicesService } from "../../src/devices/devices.service";
import { dispatchCommandSchema } from "../../src/commands/commands.dto";

type Response = { id: string; ok: boolean; result?: string };

function makeService(opts: { device?: { id: string; baseTopic: string } | null; sendCommand?: () => Promise<Response> }) {
  const commandsRepo = {
    create: (v: Partial<Command>) => ({ ...v }) as Command,
    save: vi.fn(async (v: Command) => v),
    update: vi.fn(async (): Promise<{ affected?: number }> => ({ affected: 0 })),
    find: vi.fn(async () => []),
  };
  const resultsRepo = {
    create: (v: Partial<CommandResult>) => ({ ...v }) as CommandResult,
    save: vi.fn(async (v: CommandResult) => v),
  };
  const mqtt = { sendCommand: vi.fn(opts.sendCommand ?? (async () => ({ id: "x", ok: true, result: "ok" }))) };
  const device = opts.device === undefined ? { id: "dev1", baseTopic: "espclaw/acme" } : opts.device;
  const devices = { findOne: vi.fn(async () => device) };
  const service = new CommandsService(
    commandsRepo as unknown as Repository<Command>,
    resultsRepo as unknown as Repository<CommandResult>,
    mqtt as unknown as MqttService,
    devices as unknown as DevicesService,
  );
  return { service, commandsRepo, resultsRepo, mqtt, devices };
}

describe("CommandsService.dispatch", () => {
  let ctx: ReturnType<typeof makeService>;
  beforeEach(() => {
    ctx = makeService({});
  });

  it("uses ONE id for the DB row and the MQTT wire message (audit B1)", async () => {
    const { command } = await ctx.service.dispatch("dev1", { name: "mqtt_status" });
    const wireOptions = ctx.mqtt.sendCommand.mock.calls[0][2] as { id: string };
    expect(wireOptions.id).toBe(command.id);
  });

  it("takes the topic prefix from the registry row, never from the caller (audit B4)", async () => {
    await ctx.service.dispatch("dev1", { name: "mqtt_status" });
    const wireOptions = ctx.mqtt.sendCommand.mock.calls[0][2] as { baseTopic: string };
    expect(wireOptions.baseTopic).toBe("espclaw/acme");
  });

  it("refuses to command an unregistered device instead of creating one (audit B2)", async () => {
    const c = makeService({ device: null });
    await expect(c.service.dispatch("ghost", { name: "x" })).rejects.toBeInstanceOf(NotFoundException);
    expect(c.mqtt.sendCommand).not.toHaveBeenCalled();
    expect(c.commandsRepo.save).not.toHaveBeenCalled();
  });

  it.each([
    ["ok:true", { id: "i", ok: true, result: "r" }, "succeeded"],
    ["legacy denial prefix", { id: "i", ok: false, result: "Denied agent cap call ... reason=root_agent_only" }, "rejected"],
    ["real device denial text (audit B13)", { id: "i", ok: false, result: "Error: cap 'ota_update' is not exposed to the LLM." }, "rejected"],
    ["denial with reason", { id: "i", ok: false, result: "Error: cap 'write_file' is not exposed to the LLM (reason=local_only)." }, "rejected"],
    ["device-side timeout text", { id: "i", ok: false, result: "operation timed out" }, "timed_out"],
    ["other failure", { id: "i", ok: false, result: "boom" }, "failed"],
  ])("classifies %s as %s", async (_l, response, status) => {
    const c = makeService({ sendCommand: async () => response });
    const { command, result } = await c.service.dispatch("dev1", { name: "n" });
    expect(command.status).toBe(status);
    expect(result.ok).toBe(response.ok);
  });

  it("records a timed_out command when no response arrives", async () => {
    const c = makeService({
      sendCommand: async () => {
        throw new Error("Command abc to device dev1 timed out after 200ms");
      },
    });
    const { command, result } = await c.service.dispatch("dev1", { name: "n" });
    expect(command.status).toBe("timed_out");
    expect(result.ok).toBe(false);
  });
});

describe("CommandsService orphan sweep (audit B7)", () => {
  it("closes commands left pending by a previous process", async () => {
    const c = makeService({});
    c.commandsRepo.update.mockResolvedValueOnce({ affected: 3 });
    await c.service.onModuleInit();
    expect(c.commandsRepo.update).toHaveBeenCalledWith(
      { status: "pending" },
      expect.objectContaining({ status: "timed_out", resolvedAt: expect.any(Date) }),
    );
  });

  it("never blocks boot if the sweep fails", async () => {
    const c = makeService({});
    c.commandsRepo.update.mockRejectedValueOnce(new Error("db down"));
    await expect(c.service.onModuleInit()).resolves.toBeUndefined();
  });
});

describe("dispatchCommandSchema", () => {
  it("accepts a minimal valid body", () => {
    expect(dispatchCommandSchema.safeParse({ name: "mqtt_status" }).success).toBe(true);
  });

  it.each([
    ["missing name", {}],
    ["empty name", { name: "" }],
    ["non-string name", { name: 5 }],
    ["baseTopic is no longer accepted (B4)", { name: "x", baseTopic: "other/tenant" }],
    ["timeout too small", { name: "x", timeoutMs: 1 }],
    ["timeout too large", { name: "x", timeoutMs: 10 * 60_000 }],
    ["input not an object", { name: "x", input: "no" }],
  ])("rejects %s", (_l, body) => {
    expect(dispatchCommandSchema.safeParse(body).success).toBe(false);
  });
});
