import { describe, expect, it } from "vitest";
import { MetricsService } from "../../src/observability/metrics.service";
import { JsonLogger } from "../../src/observability/json-logger";
import { InProcessEventBus, createEvent, runWithContext } from "../../src/platform";
import type { MqttService } from "../../src/mqtt";

const mqtt = (connected: boolean) => ({ isConnected: () => connected }) as unknown as MqttService;

describe("MetricsService", () => {
  it("exposes HTTP latency by route template, command latency and event counts", async () => {
    const bus = new InProcessEventBus();
    const metrics = new MetricsService(bus, mqtt(true), bus);
    metrics.onModuleInit();

    metrics.observeHttp("GET", "/devices/:id", 200, 0.03);
    bus.publish(
      createEvent({
        type: "device.command.completed",
        source: "t",
        deviceId: "d1",
        payload: { commandId: "c", name: "n", status: "succeeded", ok: true, durationMs: 1500 },
      }),
    );
    await bus.drain();

    const text = await metrics.render();
    expect(text).toContain('http_request_duration_seconds_count{method="GET",route="/devices/:id",status="200"} 1');
    expect(text).toContain('esp_claw_command_duration_seconds_count{status="succeeded"} 1');
    expect(text).toContain('esp_claw_events_total{type="device.command.completed"} 1');
    expect(text).toContain("esp_claw_mqtt_connected 1");
    expect(text).toContain("process_cpu_user_seconds_total"); // default process metrics are present
  });

  it("reports MQTT as disconnected and exposes bus totals as true counters", async () => {
    const bus = new InProcessEventBus();
    const metrics = new MetricsService(bus, mqtt(false), bus);
    metrics.onModuleInit();
    bus.publish(createEvent({ type: "a.b", source: "t", payload: {} }));
    await bus.drain();

    const first = await metrics.render();
    expect(first).toContain("esp_claw_mqtt_connected 0");
    expect(first).toMatch(/esp_claw_event_bus_published_total 1\b/);
    expect(first).toContain("# TYPE esp_claw_event_bus_published_total counter");
    // scraping twice must not double count
    expect(await metrics.render()).toMatch(/esp_claw_event_bus_published_total 1\b/);
  });

  it("uses a private registry (two instances do not collide)", () => {
    const bus = new InProcessEventBus();
    expect(() => {
      new MetricsService(bus, mqtt(true), bus);
      new MetricsService(bus, mqtt(true), bus);
    }).not.toThrow();
  });
});

describe("JsonLogger", () => {
  function capture(fn: () => void): Record<string, unknown>[] {
    const lines: string[] = [];
    const outWrite = process.stdout.write.bind(process.stdout);
    const errWrite = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((s: string) => (lines.push(s), true)) as never;
    process.stderr.write = ((s: string) => (lines.push(s), true)) as never;
    try {
      fn();
    } finally {
      process.stdout.write = outWrite;
      process.stderr.write = errWrite;
    }
    return lines.map((l) => JSON.parse(l));
  }

  it("writes one JSON object per line with level, time, context and message", () => {
    const [line] = capture(() => new JsonLogger().log("hello", "MyService"));
    expect(line).toMatchObject({ level: "log", context: "MyService", msg: "hello" });
    expect(new Date(line.time as string).toISOString()).toBe(line.time);
  });

  it("attaches the active request's correlation id", () => {
    const [line] = capture(() =>
      runWithContext({ correlationId: "req-5", traceId: null, spanId: null }, () => new JsonLogger().warn("careful", "Ctx")),
    );
    expect(line).toMatchObject({ level: "warn", correlation_id: "req-5" });
  });

  it("keeps a stack trace on errors and stays valid JSON for object messages", () => {
    const lines = capture(() => {
      new JsonLogger().error("failed", "at x.js:1", "Ctx");
      new JsonLogger().log({ a: 1 }, "Ctx");
    });
    expect(lines[0]).toMatchObject({ level: "error", stack: "at x.js:1", context: "Ctx" });
    expect(lines[1].msg).toBe('{"a":1}');
  });

  it("drops lines below the minimum level", () => {
    const lines = capture(() => {
      new JsonLogger("warn").log("quiet");
      new JsonLogger("warn").warn("loud");
    });
    expect(lines.map((l) => l.msg)).toEqual(["loud"]);
  });
});
