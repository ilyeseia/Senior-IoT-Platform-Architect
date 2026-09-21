import { describe, expect, it, vi } from "vitest";
import type { ConfigService } from "@nestjs/config";
import { TelemetryPollerService } from "../../src/telemetry/telemetry-poller.service";
import type { DevicesService } from "../../src/devices/devices.service";
import type { CommandsService } from "../../src/commands/commands.service";
import type { TelemetryService } from "../../src/telemetry/telemetry.service";
import type { TwinService } from "../../src/twin/twin.service";
import { RecordingEventBus } from "../helpers/recording-bus";
import type { Env } from "../../src/config/env.validation";

function make(
  groupsByDevice: Record<string, string[]>,
  dispatchResult: { ok: boolean; result: string } = { ok: true, result: '{"connected":true}' },
) {
  const devices = {
    findOnline: vi.fn(async (): Promise<{ id: string }[]> => Object.keys(groupsByDevice).map((id) => ({ id }))),
    hasCapabilityGroup: vi.fn(async (id: string, group: string) => groupsByDevice[id]?.includes(group) ?? false),
  };
  const commands = { dispatch: vi.fn(async (_id: string, _input: { name: string }) => ({ result: dispatchResult })) };
  const telemetry = { recordCapabilityResult: vi.fn(async () => 1) };
  const twin = { mergeReported: vi.fn(async () => undefined) };
  const bus = new RecordingEventBus();
  const config = { get: () => undefined } as unknown as ConfigService<Env, true>;
  const poller = new TelemetryPollerService(
    config,
    devices as unknown as DevicesService,
    commands as unknown as CommandsService,
    telemetry as unknown as TelemetryService,
    twin as unknown as TwinService,
    bus,
  );
  return { poller, devices, commands, telemetry, twin, bus };
}

describe("TelemetryPollerService.pollOnce", () => {
  it("polls only capabilities whose owning group the device reported", async () => {
    const { poller, commands } = make({ d1: ["cap_mqtt", "cap_ota"], d2: [] });
    await poller.pollOnce();
    const called = commands.dispatch.mock.calls.map((c) => `${c[0]}:${c[1].name}`);
    expect(called.sort()).toEqual(["d1:mqtt_status", "d1:ota_status"]);
  });

  it("stores samples for ok results and skips failed ones", async () => {
    const ok = make({ d1: ["cap_mqtt"] });
    await ok.poller.pollOnce();
    expect(ok.telemetry.recordCapabilityResult).toHaveBeenCalledWith("d1", "mqtt_status", '{"connected":true}');

    const bad = make({ d1: ["cap_mqtt"] }, { ok: false, result: "boom" });
    await bad.poller.pollOnce();
    expect(bad.telemetry.recordCapabilityResult).not.toHaveBeenCalled();
  });

  it("also merges the extracted samples into the digital twin's reported state", async () => {
    const { poller, twin } = make({ d1: ["cap_mqtt"] });
    await poller.pollOnce();
    expect(twin.mergeReported).toHaveBeenCalledWith("d1", [
      { metric: "connected", valueNumeric: null, valueBool: true },
    ]);
  });

  it("publishes device.telemetry.updated with the sample count", async () => {
    const { poller, bus } = make({ d1: ["cap_mqtt"] });
    await poller.pollOnce();
    expect(bus.ofType("device.telemetry.updated")).toHaveLength(1);
    expect(bus.ofType("device.telemetry.updated")[0]).toMatchObject({
      device_id: "d1",
      source: "module:telemetry",
      payload: { source: "mqtt_status", samples: 1 },
    });
  });

  it("keeps polling other devices when one dispatch throws", async () => {
    const { poller, commands, telemetry } = make({ d1: ["cap_mqtt"], d2: ["cap_mqtt"] });
    commands.dispatch.mockRejectedValueOnce(new Error("device not registered"));
    await poller.pollOnce();
    expect(commands.dispatch).toHaveBeenCalledTimes(2);
    expect(telemetry.recordCapabilityResult).toHaveBeenCalledTimes(1);
  });

  it("skips a tick while the previous cycle is still running", async () => {
    const { poller, devices } = make({ d1: ["cap_mqtt"] });
    let release!: () => void;
    devices.findOnline.mockImplementationOnce(() => new Promise((resolve) => (release = () => resolve([]))));
    const first = poller.pollOnce();
    await poller.pollOnce(); // overlapping call returns immediately
    expect(devices.findOnline).toHaveBeenCalledTimes(1);
    release();
    await first;
  });
});
