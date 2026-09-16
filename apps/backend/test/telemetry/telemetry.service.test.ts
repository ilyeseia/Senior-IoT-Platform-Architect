import { describe, expect, it } from "vitest";
import { extractSamples } from "../../src/telemetry/telemetry.service";

describe("extractSamples", () => {
  it("extracts numeric and boolean top-level fields from a real vpn_status result", () => {
    // Exact shape authored in esp-claw-2's cap_vpn.c this session.
    const result = JSON.stringify({
      mode: "tailscale-gateway",
      enabled: true,
      gateway: "192.168.1.10",
      test_host: "searxng.tailXXXX.ts.net",
      test_port: 80,
      dns_ok: true,
      dns_ms: 12,
      resolved_ip: "100.101.102.103",
      reachable: true,
      connect_ms: 34,
    });

    const samples = extractSamples(result);
    const byMetric = Object.fromEntries(samples.map((s) => [s.metric, s]));

    expect(byMetric.test_port).toEqual({ metric: "test_port", valueNumeric: 80, valueBool: null });
    expect(byMetric.dns_ms).toEqual({ metric: "dns_ms", valueNumeric: 12, valueBool: null });
    expect(byMetric.connect_ms).toEqual({ metric: "connect_ms", valueNumeric: 34, valueBool: null });
    expect(byMetric.enabled).toEqual({ metric: "enabled", valueNumeric: null, valueBool: true });
    expect(byMetric.dns_ok).toEqual({ metric: "dns_ok", valueNumeric: null, valueBool: true });
    expect(byMetric.reachable).toEqual({ metric: "reachable", valueNumeric: null, valueBool: true });

    // Strings are not telemetry samples.
    expect(byMetric.mode).toBeUndefined();
    expect(byMetric.gateway).toBeUndefined();
    expect(byMetric.resolved_ip).toBeUndefined();
    expect(samples).toHaveLength(6);
  });

  it("extracts from a real mqtt_status result shape", () => {
    const result = JSON.stringify({
      connected: true,
      broker: "kangaroo.rmq.cloudamqp.com",
      port: 1883,
      tx: 42,
      rx: 7,
      reconnects: 0,
    });
    const samples = extractSamples(result);
    expect(samples.map((s) => s.metric).sort()).toEqual(["connected", "port", "reconnects", "rx", "tx"]);
  });

  it("returns [] for a plain-text (non-JSON) result", () => {
    expect(extractSamples("Denied agent cap call ... reason=root_agent_only")).toEqual([]);
  });

  it("returns [] for null/undefined/empty result", () => {
    expect(extractSamples(null)).toEqual([]);
    expect(extractSamples(undefined)).toEqual([]);
    expect(extractSamples("")).toEqual([]);
  });

  it("returns [] for a JSON array or scalar (not an object)", () => {
    expect(extractSamples("[1,2,3]")).toEqual([]);
    expect(extractSamples("42")).toEqual([]);
    expect(extractSamples('"just a string"')).toEqual([]);
  });

  it("skips nested objects/arrays/null/string fields but keeps sibling scalars", () => {
    const result = JSON.stringify({
      count: 3,
      active: false,
      nested: { a: 1 },
      list: [1, 2],
      label: "text",
      missing: null,
    });
    const samples = extractSamples(result);
    expect(samples.map((s) => s.metric).sort()).toEqual(["active", "count"]);
  });

  it("treats NaN/Infinity as non-telemetry (JSON.parse never produces them, but guard anyway)", () => {
    // JSON has no NaN/Infinity literals; this exercises the Number.isFinite guard defensively.
    const samples = extractSamples(JSON.stringify({ ok: 1 }));
    expect(samples).toEqual([{ metric: "ok", valueNumeric: 1, valueBool: null }]);
  });
});
