import { describe, expect, it } from "vitest";
import {
  parseCommandEnvelope,
  parseResponseEnvelope,
  parseStatusEnvelope,
} from "../src/envelope";

describe("CommandEnvelope", () => {
  it("accepts the real capability-call shape", () => {
    const cmd = parseCommandEnvelope({
      id: "cmd-9f3a1e2b",
      action: "capability",
      name: "get_system_info",
      input: { sections: ["uptime"] },
    });
    expect(cmd.name).toBe("get_system_info");
  });

  it("defaults input to an empty object when omitted", () => {
    const cmd = parseCommandEnvelope({ id: "cmd-1", action: "capability", name: "mqtt_status" });
    expect(cmd.input).toEqual({});
  });

  it("rejects an action other than 'capability'", () => {
    expect(() =>
      parseCommandEnvelope({ id: "cmd-1", action: "text", name: "x" }),
    ).toThrow();
  });

  it("rejects a missing id or name", () => {
    expect(() => parseCommandEnvelope({ action: "capability", name: "x" })).toThrow();
    expect(() => parseCommandEnvelope({ id: "cmd-1", action: "capability" })).toThrow();
  });
});

describe("ResponseEnvelope", () => {
  it("accepts a real successful response", () => {
    const res = parseResponseEnvelope({
      id: "loop1",
      capability: "get_current_time",
      ok: true,
      result: "2026-09-15 12:00:00",
    });
    expect(res.ok).toBe(true);
  });

  it("accepts a real denied-capability response verified live this session", () => {
    const res = parseResponseEnvelope({
      id: "sectest1",
      capability: "ota_update",
      ok: false,
      result: "Denied agent cap call cap=ota_update reason=root_agent_only caller=sub_agent",
    });
    expect(res.ok).toBe(false);
  });
});

describe("StatusEnvelope", () => {
  it("accepts the real birth payload", () => {
    expect(parseStatusEnvelope({ online: true }).online).toBe(true);
  });

  it("accepts the real LWT payload", () => {
    expect(parseStatusEnvelope({ online: false }).online).toBe(false);
  });
});
