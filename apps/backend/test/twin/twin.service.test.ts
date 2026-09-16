import { describe, expect, it, beforeEach } from "vitest";
import type { Repository } from "typeorm";
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

  beforeEach(() => {
    repo = fakeShadowRepo();
    service = new TwinService(repo);
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
      { metric: "sampling_interval", valueNumeric: 30, valueBool: null },
      { metric: "pump", valueNumeric: null, valueBool: false },
    ]);
    const shadow = await service.getShadow("dev3");
    expect(shadow.reported).toEqual({ sampling_interval: 30, pump: false });
    expect(shadow.reportedVersion).toBe(1);
  });

  it("detects drift only on keys present in desired that differ from reported", async () => {
    await service.setDesired("dev4", { sampling_interval: 30, pump: true });
    await service.mergeReported("dev4", [
      { metric: "sampling_interval", valueNumeric: 30, valueBool: null },
      { metric: "pump", valueNumeric: null, valueBool: false },
      { metric: "unrelated_metric", valueNumeric: 99, valueBool: null },
    ]);

    const shadow = await service.getShadow("dev4");
    expect(shadow.drift).toEqual(["pump"]); // sampling_interval matches, pump doesn't
    expect(shadow.inSync).toBe(false);
  });

  it("is in sync once reported catches up to desired", async () => {
    await service.setDesired("dev5", { pump: true });
    await service.mergeReported("dev5", [{ metric: "pump", valueNumeric: null, valueBool: false }]);
    expect((await service.getShadow("dev5")).inSync).toBe(false);

    await service.mergeReported("dev5", [{ metric: "pump", valueNumeric: null, valueBool: true }]);
    const shadow = await service.getShadow("dev5");
    expect(shadow.inSync).toBe(true);
    expect(shadow.drift).toEqual([]);
  });
});
