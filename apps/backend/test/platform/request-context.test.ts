import { describe, expect, it } from "vitest";
import { contextFromHeaders, currentContext, runWithContext } from "../../src/platform/context/request-context";
import { CorrelationMiddleware } from "../../src/platform/context/correlation.middleware";

describe("contextFromHeaders", () => {
  it("accepts a well-formed x-correlation-id", () => {
    expect(contextFromHeaders({ "x-correlation-id": "req-123.abc_DEF" }).correlationId).toBe("req-123.abc_DEF");
  });

  it.each([
    ["too long", "x".repeat(129)],
    ["contains a newline (log/header injection)", "abc\r\nSet-Cookie: x=1"],
    ["contains spaces", "a b"],
    ["empty", ""],
  ])("replaces an unsafe id (%s) with a fresh one", (_l, bad) => {
    const id = contextFromHeaders({ "x-correlation-id": bad }).correlationId;
    expect(id).not.toBe(bad);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("generates an id when none is supplied", () => {
    expect(contextFromHeaders({}).correlationId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("parses a W3C traceparent", () => {
    const ctx = contextFromHeaders({ traceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-01` });
    expect(ctx.traceId).toBe("a".repeat(32));
    expect(ctx.spanId).toBe("b".repeat(16));
  });

  it("ignores a malformed traceparent", () => {
    const ctx = contextFromHeaders({ traceparent: "garbage" });
    expect(ctx.traceId).toBeNull();
    expect(ctx.spanId).toBeNull();
  });
});

describe("CorrelationMiddleware", () => {
  it("sets the response header and makes the context visible to downstream async code", async () => {
    const headers: Record<string, string> = {};
    let seenInside: string | undefined;
    await new Promise<void>((resolve) => {
      new CorrelationMiddleware().use(
        { headers: { "x-correlation-id": "corr-1" } },
        { setHeader: (k, v) => void (headers[k] = v) },
        () => {
          setTimeout(() => {
            seenInside = currentContext()?.correlationId;
            resolve();
          }, 5);
        },
      );
    });
    expect(headers["x-correlation-id"]).toBe("corr-1");
    expect(seenInside).toBe("corr-1");
    expect(currentContext()).toBeUndefined(); // no leakage outside the request
  });

  it("keeps concurrent requests isolated", async () => {
    const seen: string[] = [];
    const run = (id: string, delay: number) =>
      new Promise<void>((resolve) =>
        runWithContext({ correlationId: id, traceId: null, spanId: null }, () =>
          setTimeout(() => {
            seen.push(`${id}:${currentContext()?.correlationId}`);
            resolve();
          }, delay),
        ),
      );
    await Promise.all([run("a", 15), run("b", 5)]);
    expect(seen.sort()).toEqual(["a:a", "b:b"]);
  });
});
