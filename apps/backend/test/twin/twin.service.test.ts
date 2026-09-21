import { describe, expect, it, beforeEach } from "vitest";
import type { Repository } from "typeorm";
import { RecordingEventBus } from "../helpers/recording-bus";
import { createEvent } from "../../src/platform";
import { TwinService } from "../../src/twin/twin.service";
import { DeviceShadow } from "../../src/twin/device-shadow.entity";

/** Same minimal in-memory Repository stand-in style as identity.service.test.ts. */
function fakeShadowRepo(): Repository<DeviceShadow> {
  const rows = new Map<string, DeviceShadow>();
  return {
    findOne: async ({ where }: { where: { deviceId: string } }) => rows.get(where.deviceId) ?? null,
    create: (partial: Partial<DeviceShadow>) => ({ ...partial }) as DeviceShadow,
    save: async (row: DeviceShadow) => {
      const saved = { ...row, updatedAt: new Date() } as DeviceShadow;
      rows.set(saved.deviceId, saved);
      return saved;
    },
  } as unknown as Repository<DeviceShadow>;
}

describe("TwinService", () => {
  let repo: Repository<DeviceShadow>;
  let service: TwinService;
  let bus: RecordingEventBus;

  beforeEach(() => {
    repo = fakeShadowRepo();
    bus = new RecordingEventBus();
    service = new TwinService(repo, bus);
  });

  it("returns an empty, in-sync shadow for a device with no row yet", async () => {
    const shadow = await service.getShadow("no-such-device");
    expect(shadow).toMatchObject({
      deviceId: "no-such-device",
      desired: {},
      reported: {},
      desiredVersion: 0,
      reportedVersion: 0,
      drift: [],
      inSync: true,
    });
  });

  it("setDesired creates a row, merges the patch, and bumps desiredVersion every call", async () => {
    const first = await service.setDesired("dev1", { sampling_interval: 30 });
    expect(first.desired).toEqual({ sampling_interval: 30 });
    expect(first.desiredVersion).toBe(1);

    // Same value again — version still bumps (records operator intent, not a value diff).
    const second = await service.setDesired("dev1", { sampling_interval: 30 });
    expect(second.desiredVersion).toBe(2);

    const third = await service.setDesired("dev1", { pump: true });
    expect(third.desired).toEqual({ sampling_interval: 30, pump: true });
    expect(third.desiredVersion).toBe(3);
  });

  it("mergeReported is a no-op for an empty sample list (no row created)", async () => {
    await service.mergeReported("dev2", []);
    const shadow = await service.getShadow("dev2");
    expect(shadow.reportedVersion).toBe(0);
    expect(shadow.reported).toEqual({});
  });

  it("mergeReported writes numeric and boolean samples as plain values and bumps reportedVersion", async () => {
    await service.mergeReported("dev3", [
      { metric: "sampling_interval", value: 30 },
      { metric: "pump", value: false },
    ]);
    const shadow = await service.getShadow("dev3");
    expect(shadow.reported).toEqual({ sampling_interval: 30, pump: false });
    expect(shadow.reportedVersion).toBe(1);
  });

  it("detects drift only on keys present in desired that differ from reported", async () => {
    await service.setDesired("dev4", { sampling_interval: 30, pump: true });
    await service.mergeReported("dev4", [
      { metric: "sampling_interval", value: 30 },
      { metric: "pump", value: false },
      { metric: "unrelated_metric", value: 99 },
    ]);

    const shadow = await service.getShadow("dev4");
    expect(shadow.drift).toEqual(["pump"]); // sampling_interval matches, pump doesn't
    expect(shadow.inSync).toBe(false);
  });

  it("is in sync once reported catches up to desired", async () => {
    await service.setDesired("dev5", { pump: true });
    await service.mergeReported("dev5", [{ metric: "pump", value: false }]);
    expect((await service.getShadow("dev5")).inSync).toBe(false);

    await service.mergeReported("dev5", [{ metric: "pump", value: true }]);
    const shadow = await service.getShadow("dev5");
    expect(shadow.inSync).toBe(true);
    expect(shadow.drift).toEqual([]);
  });

  it("publishes device.state.changed when an operator sets desired state", async () => {
    const view = await service.setDesired("d1", { sampling_interval: 30 });
    const [event] = bus.ofType("device.state.changed");
    expect(event).toMatchObject({
      device_id: "d1",
      source: "module:twin",
      payload: { changed: { sampling_interval: 30 }, desiredVersion: 1, drift: view.drift },
    });
  });

  it("folds telemetry events into reported state via the bus (no dependency on the telemetry module)", async () => {
    service.onModuleInit();
    const sub = bus.subscriptions.find((s) => s.pattern === "device.telemetry.updated");
    expect(sub).toBeDefined();
    await sub!.handler(
      createEvent({
        type: "device.telemetry.updated",
        source: "module:telemetry",
        deviceId: "dev6",
        payload: { source: "mqtt_status", count: 2, samples: [{ metric: "connected", value: true }, { metric: "qos", value: 1 }] },
      }),
    );
    const shadow = await service.getShadow("dev6");
    expect(shadow.reported).toEqual({ connected: true, qos: 1 });
    expect(shadow.reportedVersion).toBe(1);
  });

  it("ignores a telemetry event that has no device id", async () => {
    service.onModuleInit();
    const sub = bus.subscriptions.find((s) => s.pattern === "device.telemetry.updated")!;
    await sub.handler(createEvent({ type: "device.telemetry.updated", source: "m", payload: { source: "x", count: 0, samples: [] } }));
    expect((await service.getShadow("nobody")).reportedVersion).toBe(0);
  });
});
