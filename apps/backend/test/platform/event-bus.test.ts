import { describe, expect, it } from "vitest";
import { InProcessEventBus, matchesPattern } from "../../src/platform/events/in-process-event-bus";
import { createEvent } from "../../src/platform/events/domain-event";
import { runWithContext } from "../../src/platform/context/request-context";
import type { DomainEvent } from "../../src/platform/events/domain-event";

const ev = (type: string, deviceId: string | null = "d1", payload: unknown = {}): DomainEvent =>
  createEvent({ type, source: "test", deviceId, payload });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("matchesPattern", () => {
  it.each([
    ["device.online", "device.online", true],
    ["device.*", "device.online", true],
    ["device.*", "device.command.completed", false],
    ["device.command.*", "device.command.completed", true],
    ["device.**", "device.command.completed", true],
    ["device.**", "device", false],
    ["**", "anything.at.all", true],
    ["device.online", "device.offline", false],
    ["*.online", "device.online", true],
    ["device.online.extra", "device.online", false],
  ])("%s vs %s => %s", (pattern, type, expected) => {
    expect(matchesPattern(pattern, type)).toBe(expected);
  });
});

describe("createEvent", () => {
  it("fills the standard envelope", () => {
    const e = createEvent({ type: "device.online", source: "module:devices", deviceId: "d1", payload: { previous: false } });
    expect(e).toMatchObject({
      event_type: "device.online",
      schema_version: 1,
      device_id: "d1",
      organization_id: null,
      source: "module:devices",
      causation_id: null,
      sequence: null,
      idempotency_key: null,
      payload: { previous: false },
    });
    expect(e.event_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Date(e.timestamp).toISOString()).toBe(e.timestamp);
    expect(e.correlation_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("inherits correlation and trace ids from the request context", () => {
    const e = runWithContext({ correlationId: "req-42", traceId: "a".repeat(32), spanId: "b".repeat(16) }, () =>
      createEvent({ type: "x.y", source: "test", payload: {} }),
    );
    expect(e.correlation_id).toBe("req-42");
    expect(e.trace_id).toBe("a".repeat(32));
    expect(e.span_id).toBe("b".repeat(16));
  });

  it("gives every event a distinct id", () => {
    expect(ev("a.b").event_id).not.toBe(ev("a.b").event_id);
  });
});

describe("InProcessEventBus", () => {
  it("delivers to matching subscribers only, asynchronously", async () => {
    const bus = new InProcessEventBus();
    const seen: string[] = [];
    bus.subscribe("device.online", (e) => void seen.push(`online:${e.event_id}`), { name: "a" });
    bus.subscribe("device.offline", (e) => void seen.push(`offline:${e.event_id}`), { name: "b" });
    const event = ev("device.online");
    bus.publish(event);
    expect(seen).toEqual([]); // publish is an enqueue
    await bus.drain();
    expect(seen).toEqual([`online:${event.event_id}`]);
  });

  it("delivers one device's events strictly in publish order, even with a slow first handler", async () => {
    const bus = new InProcessEventBus();
    const order: string[] = [];
    bus.subscribe(
      "device.presence.reported",
      async (e) => {
        const online = (e.payload as { online: boolean }).online;
        if (online) await sleep(40); // the first event is the slow one
        order.push(online ? "online" : "offline");
      },
      { name: "presence" },
    );
    bus.publish(ev("device.presence.reported", "d1", { online: true }));
    bus.publish(ev("device.presence.reported", "d1", { online: false }));
    await bus.drain();
    expect(order).toEqual(["online", "offline"]); // without ordering the fast one would finish first
  });

  it("does not serialise different devices", async () => {
    const bus = new InProcessEventBus();
    const finished: string[] = [];
    bus.subscribe(
      "x.y",
      async (e) => {
        if (e.device_id === "slow") await sleep(50);
        finished.push(e.device_id as string);
      },
      { name: "h" },
    );
    bus.publish(ev("x.y", "slow"));
    bus.publish(ev("x.y", "fast"));
    await bus.drain();
    expect(finished).toEqual(["fast", "slow"]);
  });

  it("isolates a failing handler from the others and from the publisher", async () => {
    const bus = new InProcessEventBus();
    const ok: string[] = [];
    bus.subscribe("x.y", () => Promise.reject(new Error("boom")), { name: "bad" });
    bus.subscribe("x.y", () => void ok.push("good"), { name: "good" });
    expect(() => bus.publish(ev("x.y"))).not.toThrow();
    await bus.drain();
    expect(ok).toEqual(["good"]);
    expect(bus.stats().failed).toBe(1);
  });

  it("retries a handler that asked for it, with backoff", async () => {
    const bus = new InProcessEventBus();
    let calls = 0;
    bus.subscribe(
      "x.y",
      () => {
        calls++;
        if (calls < 3) throw new Error("transient");
      },
      { name: "flaky", retries: 3, backoffMs: 1 },
    );
    bus.publish(ev("x.y"));
    await bus.drain();
    expect(calls).toBe(3);
    expect(bus.stats().failed).toBe(0);
  });

  it("gives up after the retries are exhausted", async () => {
    const bus = new InProcessEventBus();
    let calls = 0;
    bus.subscribe("x.y", () => { calls++; throw new Error("always"); }, { name: "dead", retries: 2, backoffMs: 1 });
    bus.publish(ev("x.y"));
    await bus.drain();
    expect(calls).toBe(3);
    expect(bus.stats().failed).toBe(1);
  });

  it("stops waiting for a handler that exceeds its timeout, and moves on to the next event", async () => {
    const bus = new InProcessEventBus();
    const seen: string[] = [];
    bus.subscribe(
      "x.y",
      async (e) => {
        if ((e.payload as { hang?: boolean }).hang) await sleep(500);
        seen.push("done");
      },
      { name: "slow", timeoutMs: 20 },
    );
    const started = Date.now();
    bus.publish(ev("x.y", "d1", { hang: true }));
    bus.publish(ev("x.y", "d1", {}));
    await bus.drain();
    expect(Date.now() - started).toBeLessThan(400);
    expect(bus.stats().timedOut).toBe(1);
    expect(seen).toContain("done");
  });

  it("unsubscribe stops delivery", async () => {
    const bus = new InProcessEventBus();
    let n = 0;
    const off = bus.subscribe("x.y", () => void n++, { name: "h" });
    bus.publish(ev("x.y"));
    await bus.drain();
    off();
    bus.publish(ev("x.y"));
    await bus.drain();
    expect(n).toBe(1);
  });

  it("counts published events even when nobody listens", () => {
    const bus = new InProcessEventBus();
    bus.publish(ev("nobody.listens"));
    expect(bus.stats().published).toBe(1);
  });

  it("lets a handler publish a follow-up event for the same device without deadlocking", async () => {
    const bus = new InProcessEventBus();
    const seen: string[] = [];
    bus.subscribe("a.first", (e) => { seen.push("first"); bus.publish(ev("a.second", e.device_id)); }, { name: "one" });
    bus.subscribe("a.second", () => void seen.push("second"), { name: "two" });
    bus.publish(ev("a.first", "d1"));
    await bus.drain();
    expect(seen).toEqual(["first", "second"]);
  });
});
