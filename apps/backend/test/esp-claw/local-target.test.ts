import { describe, expect, it } from "vitest";
import {
  assertSafeLocalTarget,
  isPrivateIPv4,
  LocalTargetError,
  parseAllowedHosts,
} from "../../src/esp-claw/local-target";

describe("assertSafeLocalTarget (SSRF guard, audit B3)", () => {
  it.each([
    "100.108.45.150", // Tailscale CGNAT
    "http://10.0.0.9",
    "192.168.1.20:8080",
    "http://172.16.5.4",
    "172.31.255.1",
  ])("accepts private/Tailscale IPv4 %s", (input) => {
    expect(() => assertSafeLocalTarget(input)).not.toThrow();
  });

  it.each([
    ["public IPv4", "8.8.8.8"],
    ["loopback", "127.0.0.1"],
    ["link-local / cloud metadata", "169.254.169.254"],
    ["Alibaba metadata inside CGNAT", "100.100.100.200"],
    ["172.32 (outside 172.16/12)", "172.32.0.1"],
    ["100.63 (outside 100.64/10)", "100.63.0.1"],
    ["arbitrary DNS name", "evil.example.com"],
    ["localhost", "localhost"],
    ["IPv6 literal", "http://[::1]"],
    ["https scheme", "https://10.0.0.9"],
    ["other scheme", "file:///etc/passwd"],
    ["embedded credentials", "http://user:pw@10.0.0.9"],
    ["sensitive port", "10.0.0.9:6379"],
    ["out-of-range octet", "10.0.0.300"],
    ["empty", "  "],
  ])("refuses %s", (_label, input) => {
    expect(() => assertSafeLocalTarget(input)).toThrow(LocalTargetError);
  });

  it("allows an exact hostname only when it is on the operator allow-list", () => {
    expect(() => assertSafeLocalTarget("dev.tail1234.ts.net")).toThrow(LocalTargetError);
    expect(() => assertSafeLocalTarget("dev.tail1234.ts.net", ["dev.tail1234.ts.net"])).not.toThrow();
    expect(() => assertSafeLocalTarget("other.tail1234.ts.net", ["dev.tail1234.ts.net"])).toThrow(
      LocalTargetError,
    );
  });

  it("parseAllowedHosts trims, lower-cases and drops empties", () => {
    expect(parseAllowedHosts(" A.ts.net , ,b.ts.net")).toEqual(["a.ts.net", "b.ts.net"]);
    expect(parseAllowedHosts(undefined)).toEqual([]);
  });

  it("isPrivateIPv4 rejects non-dotted-quad input", () => {
    expect(isPrivateIPv4("10.0.0")).toBe(false);
    expect(isPrivateIPv4("abc")).toBe(false);
  });
});
