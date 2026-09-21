import { describe, expect, it } from "vitest";
import {
  LOGIN_WINDOW_MS,
  LoginThrottle,
  MAX_FAILURES_PER_ACCOUNT,
  MAX_FAILURES_PER_ADDRESS,
} from "../../src/identity/login-throttle";

function throttleAt(clock: { t: number }): LoginThrottle {
  const throttle = new LoginThrottle();
  throttle.now = () => clock.t;
  return throttle;
}

describe("LoginThrottle", () => {
  it("allows attempts below the account limit and blocks at it", () => {
    const t = throttleAt({ t: 1_000_000 });
    for (let i = 0; i < MAX_FAILURES_PER_ACCOUNT - 1; i++) t.recordFailure("a@x.io", "1.1.1.1");
    expect(() => t.assertAllowed("a@x.io", "1.1.1.1")).not.toThrow();
    t.recordFailure("a@x.io", "1.1.1.1");
    expect(() => t.assertAllowed("a@x.io", "1.1.1.1")).toThrow(/Too many failed login attempts/);
  });

  it("treats emails case-insensitively", () => {
    const t = throttleAt({ t: 1 });
    for (let i = 0; i < MAX_FAILURES_PER_ACCOUNT; i++) t.recordFailure(i % 2 ? "A@X.io" : "a@x.io", "9.9.9.9");
    expect(() => t.assertAllowed("a@X.IO", "8.8.8.8")).toThrow();
  });

  it("blocks an address that fails against many different accounts", () => {
    const t = throttleAt({ t: 1 });
    for (let i = 0; i < MAX_FAILURES_PER_ADDRESS; i++) t.recordFailure(`u${i}@x.io`, "7.7.7.7");
    expect(() => t.assertAllowed("fresh@x.io", "7.7.7.7")).toThrow();
    expect(() => t.assertAllowed("fresh@x.io", "6.6.6.6")).not.toThrow();
  });

  it("forgets failures once they leave the window", () => {
    const clock = { t: 5_000_000 };
    const t = throttleAt(clock);
    for (let i = 0; i < MAX_FAILURES_PER_ACCOUNT; i++) t.recordFailure("a@x.io", "1.1.1.1");
    expect(() => t.assertAllowed("a@x.io", "1.1.1.1")).toThrow();
    clock.t += LOGIN_WINDOW_MS + 1;
    expect(() => t.assertAllowed("a@x.io", "1.1.1.1")).not.toThrow();
  });

  it("recordSuccess clears only the account counter", () => {
    const t = throttleAt({ t: 1 });
    for (let i = 0; i < MAX_FAILURES_PER_ACCOUNT; i++) t.recordFailure("a@x.io", "1.1.1.1");
    t.recordSuccess("a@x.io");
    expect(() => t.assertAllowed("a@x.io", "2.2.2.2")).not.toThrow();
  });
});
