import { describe, expect, it } from "vitest";
import { buildTopic, deviceTopics, parseTopic } from "../src/topics";

describe("buildTopic", () => {
  it("builds the real firmware shape for a single-segment base topic", () => {
    expect(buildTopic("espclaw", "ecda3b4ff7d4", "status")).toBe(
      "espclaw/ecda3b4ff7d4/status",
    );
  });

  it("builds correctly for a tenant-scoped (multi-segment) base topic", () => {
    expect(buildTopic("espclaw/acme-farms", "ecda3b4ff7d4", "command")).toBe(
      "espclaw/acme-farms/ecda3b4ff7d4/command",
    );
  });

  it("trims a trailing slash on the configured base topic", () => {
    expect(buildTopic("espclaw/", "ecda3b4ff7d4", "response")).toBe(
      "espclaw/ecda3b4ff7d4/response",
    );
  });

  it("rejects an empty baseTopic or deviceId", () => {
    expect(() => buildTopic("", "ecda3b4ff7d4", "status")).toThrow();
    expect(() => buildTopic("espclaw", "", "status")).toThrow();
  });
});

describe("deviceTopics", () => {
  it("returns all three real leaves", () => {
    expect(deviceTopics("espclaw", "ecda3b4ff7d4")).toEqual({
      status: "espclaw/ecda3b4ff7d4/status",
      command: "espclaw/ecda3b4ff7d4/command",
      response: "espclaw/ecda3b4ff7d4/response",
    });
  });
});

describe("parseTopic", () => {
  it("round-trips a single-segment base topic", () => {
    expect(parseTopic("espclaw/ecda3b4ff7d4/status")).toEqual({
      baseTopic: "espclaw",
      deviceId: "ecda3b4ff7d4",
      leaf: "status",
    });
  });

  it("round-trips a tenant-scoped (multi-segment) base topic", () => {
    expect(parseTopic("espclaw/acme-farms/ecda3b4ff7d4/command")).toEqual({
      baseTopic: "espclaw/acme-farms",
      deviceId: "ecda3b4ff7d4",
      leaf: "command",
    });
  });

  it("returns null for a topic with too few segments", () => {
    expect(parseTopic("espclaw/status")).toBeNull();
  });

  it("is the exact inverse of buildTopic for a tenant-scoped base topic", () => {
    const base = "espclaw/acme-farms";
    const deviceId = "ecda3b4ff7d4";
    const topic = buildTopic(base, deviceId, "response");
    expect(parseTopic(topic)).toEqual({ baseTopic: base, deviceId, leaf: "response" });
  });
});
