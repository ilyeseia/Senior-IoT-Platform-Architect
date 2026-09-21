import { describe, expect, it, vi } from "vitest";
import type { Repository } from "typeorm";
import { EventLogService } from "../../src/audit/event-log.service";
import type { EventLogRecord } from "../../src/audit/event-log.entity";
import { createEvent, InProcessEventBus, isAuditedEventType } from "../../src/platform";

/** Captures what the query builder would insert; `orIgnore` must be requested for idempotency. */
function fakeRepo() {
  const inserted: Record<string, unknown>[] = [];
  let ignored = false;
  const qb = {
    insert: () => qb,
    into: () => qb,
    values: (v: Record<string, unknown>) => (inserted.push(v), qb),
    orIgnore: () => ((ignored = true), qb),
    execute: vi.fn(async () => ({})),
  };
  return { inserted, wasIgnoreRequested: () => ignored, qb, repo: { createQueryBuilder: () => qb } as unknown as Repository<EventLogRecord> };
}

describe("isAuditedEventType", () => {
  it.each([
    ["device.registered", true],
    ["device.online", true],
    ["device.offline", true],
    ["device.command.created", true],
    ["device.command.completed", true],
    ["device.state.changed", true],
    ["device.ota.started", true],
    ["device.alert.created", true],
    ["agent.tool.executed", true],
    ["security.login.failed", true],
    ["device.telemetry.updated", false], // high volume
    ["device.presence.reported", false], // raw observation
    ["something.else", false],
  ])("%s => %s", (type, expected) => {
    expect(isAuditedEventType(type)).toBe(expected);
  });
});

describe("EventLogService", () => {
  it("records an audited event with the full envelope and requests idempotent insertion", async () => {
    const { repo, inserted, wasIgnoreRequested } = fakeRepo();
    const service = new EventLogService(repo, new InProcessEventBus());
    const event = createEvent({
      type: "device.command.completed",
      source: "module:commands",
      deviceId: "d1",
      causationId: "cmd-1",
      correlationId: "req-1",
      payload: { commandId: "cmd-1", status: "succeeded" },
    });
    await service.recordIfAudited(event);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      eventId: event.event_id,
      eventType: "device.command.completed",
      deviceId: "d1",
      source: "module:commands",
      correlationId: "req-1",
      causationId: "cmd-1",
      payload: { commandId: "cmd-1", status: "succeeded" },
    });
    expect(wasIgnoreRequested()).toBe(true); // ON CONFLICT DO NOTHING
  });

  it("skips events that are not auditable", async () => {
    const { repo, inserted } = fakeRepo();
    const service = new EventLogService(repo, new InProcessEventBus());
    await service.recordIfAudited(createEvent({ type: "device.telemetry.updated", source: "t", deviceId: "d1", payload: {} }));
    expect(inserted).toHaveLength(0);
  });

  it("subscribes to the bus on init, retries failures, and records only audited events", async () => {
    const { repo, inserted, qb } = fakeRepo();
    const bus = new InProcessEventBus();
    const service = new EventLogService(repo, bus);
    service.onModuleInit();

    qb.execute.mockRejectedValueOnce(new Error("transient db error")); // first attempt fails, retry succeeds
    bus.publish(createEvent({ type: "device.registered", source: "m", deviceId: "d1", payload: { baseTopic: "x" } }));
    bus.publish(createEvent({ type: "device.telemetry.updated", source: "m", deviceId: "d1", payload: {} }));
    await bus.drain();

    expect(qb.execute).toHaveBeenCalledTimes(2);
    expect(inserted.map((r) => r.eventType)).toEqual(["device.registered", "device.registered"]); // insert attempted twice, DB dedupes
    expect(bus.stats().failed).toBe(0);
  });
});
