import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Repository } from "typeorm";
import { DevicesService } from "../../src/devices/devices.service";
import { LocalApiClient } from "../../src/esp-claw/local-api-client";
import type { Device } from "../../src/devices/device.entity";
import type { DeviceCapability } from "../../src/devices/device-capability.entity";
import { InProcessEventBus, createEvent } from "../../src/platform";
import type { DomainEvent } from "../../src/platform";

/** In-memory Repository<Device> with just the calls DevicesService makes on the presence path. */
function fakeDeviceRepo() {
  const rows = new Map<string, Device>();
  return {
    rows,
    repo: {
      findOne: vi.fn(async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null),
      create: (v: Partial<Device>) => ({ ...v }) as Device,
      save: vi.fn(async (d: Device) => {
        rows.set(d.id, d);
        return d;
      }),
      update: vi.fn(async ({ id }: { id: string }, patch: Partial<Device>) => {
        rows.set(id, { ...rows.get(id)!, ...patch });
      }),
    } as unknown as Repository<Device>,
  };
}

const presence = (deviceId: string, online: boolean, correlationId = "corr-1"): DomainEvent =>
  createEvent({
    type: "device.presence.reported",
    source: "gateway:mqtt",
    deviceId,
    correlationId,
    payload: { baseTopic: "espclaw", online },
  });

describe("DevicesService presence handling (events, audit B6)", () => {
  let bus: InProcessEventBus;
  let db: ReturnType<typeof fakeDeviceRepo>;
  let published: DomainEvent[];

  beforeEach(() => {
    bus = new InProcessEventBus();
    db = fakeDeviceRepo();
    const service = new DevicesService(
      db.repo,
      {} as unknown as Repository<DeviceCapability>,
      new LocalApiClient(),
      bus,
    );
    service.onModuleInit();
    published = [];
    bus.subscribe("device.**", (e) => void (e.event_type !== "device.presence.reported" && published.push(e)), {
      name: "collector",
    });
  });

  it("registers a new device and announces it online on first contact", async () => {
    bus.publish(presence("d1", true));
    await bus.drain();
    expect(published.map((e) => e.event_type)).toEqual(["device.registered", "device.online"]);
    expect(db.rows.get("d1")).toMatchObject({ online: true, baseTopic: "espclaw" });
  });

  it("publishes an offline transition and carries the causation and correlation ids through", async () => {
    bus.publish(presence("d1", true));
    const offline = presence("d1", false, "corr-9");
    bus.publish(offline);
    await bus.drain();
    const last = published[published.length - 1];
    expect(last).toMatchObject({
      event_type: "device.offline",
      causation_id: offline.event_id,
      correlation_id: "corr-9",
      payload: { previous: true },
    });
  });

  it("does not repeat online for an unchanged state (retained birth message re-delivered)", async () => {
    bus.publish(presence("d1", true));
    bus.publish(presence("d1", true));
    await bus.drain();
    expect(published.filter((e) => e.event_type === "device.online")).toHaveLength(1);
    expect(published.filter((e) => e.event_type === "device.registered")).toHaveLength(1);
  });

  it("applies a rapid online -> offline flap in order, so the final state is offline", async () => {
    // Before Stage 1 the two updates were unordered async handlers and could land backwards.
    bus.publish(presence("d1", true));
    bus.publish(presence("d1", false));
    bus.publish(presence("d1", true));
    bus.publish(presence("d1", false));
    await bus.drain();
    expect(db.rows.get("d1")?.online).toBe(false);
    expect(published.filter((e) => e.event_type === "device.online")).toHaveLength(2);
    expect(published.filter((e) => e.event_type === "device.offline")).toHaveLength(2);
  });

  it("ignores an observation with no device id", async () => {
    bus.publish(createEvent({ type: "device.presence.reported", source: "gateway:mqtt", payload: { baseTopic: "x", online: true } }));
    await bus.drain();
    expect(db.rows.size).toBe(0);
  });
});
