import { describe, expect, it, vi } from "vitest";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import type { ArgumentsHost } from "@nestjs/common";
import { ApiExceptionFilter, errorCodeForStatus, normalizeException } from "../../src/platform/http/api-exception.filter";
import { runWithContext } from "../../src/platform/context/request-context";
import { ApiVersionMiddleware } from "../../src/platform/http/api-version.middleware";

function run(exception: unknown, correlationId?: string) {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  const host = { switchToHttp: () => ({ getResponse: () => ({ status }) }) } as unknown as ArgumentsHost;
  const filter = new ApiExceptionFilter();
  const call = () => filter.catch(exception, host);
  if (correlationId) runWithContext({ correlationId, traceId: null, spanId: null }, call);
  else call();
  return { status: status.mock.calls[0]?.[0] as number, body: json.mock.calls[0]?.[0] as { error: Record<string, unknown> } };
}

describe("errorCodeForStatus", () => {
  it.each([
    [400, "invalid_request"],
    [401, "unauthorized"],
    [403, "forbidden"],
    [404, "not_found"],
    [409, "conflict"],
    [429, "too_many_requests"],
    [503, "unavailable"],
    [500, "internal_error"],
    [502, "internal_error"],
    [418, "error"],
  ])("%i -> %s", (status, code) => {
    expect(errorCodeForStatus(status)).toBe(code);
  });
});

describe("ApiExceptionFilter", () => {
  it("returns the standard envelope with the correlation id", () => {
    const { status, body } = run(new NotFoundException("Device x not found"), "req-1");
    expect(status).toBe(404);
    expect(body).toEqual({ error: { code: "not_found", message: "Device x not found", status: 404, correlation_id: "req-1" } });
  });

  it.each([
    [new UnauthorizedException("Missing bearer token"), 401, "unauthorized"],
    [new ForbiddenException("nope"), 403, "forbidden"],
    [new ConflictException("Registration is closed"), 409, "conflict"],
  ])("maps %o", (exception, expectedStatus, code) => {
    const { status, body } = run(exception);
    expect(status).toBe(expectedStatus);
    expect(body.error.code).toBe(code);
  });

  it("exposes structured validation issues as details (parseBody)", () => {
    const issues = [{ path: "name", message: "Required" }];
    const { body } = run(new BadRequestException({ message: "Invalid request body", issues }));
    expect(body.error).toMatchObject({ code: "invalid_request", message: "Invalid request body", details: issues });
  });

  it("turns a class-validator style message array into details", () => {
    const { body } = run(new BadRequestException(["a must be a string", "b is required"]));
    expect(body.error).toMatchObject({ message: "Validation failed", details: ["a must be a string", "b is required"] });
  });

  it("carries readiness checks as details", () => {
    const { status, body } = run(new ServiceUnavailableException({ message: "Service not ready", details: { checks: { database: "down" } } }));
    expect(status).toBe(503);
    expect(body.error).toMatchObject({ code: "unavailable", details: { checks: { database: "down" } } });
  });

  it("never leaks the message or stack of an unexpected error", () => {
    const { status, body } = run(new Error("password=hunter2 at /srv/app/secret.js:1"), "req-9");
    expect(status).toBe(500);
    expect(JSON.stringify(body)).not.toContain("hunter2");
    expect(JSON.stringify(body)).not.toContain("secret.js");
    expect(body.error).toMatchObject({ code: "internal_error", message: "Internal server error", correlation_id: "req-9" });
  });

  it("treats a thrown non-Error the same way", () => {
    expect(run("just a string").body.error.message).toBe("Internal server error");
  });

  it("uses a null correlation id outside a request", () => {
    expect(run(new NotFoundException()).body.error.correlation_id).toBeNull();
  });

  it("normalizeException keeps the status of a custom HttpException", () => {
    expect(normalizeException(new HttpException("teapot", 418))).toEqual({ status: 418, message: "teapot" });
  });
});

describe("ApiVersionMiddleware", () => {
  const headersFor = (url: string) => {
    const headers: Record<string, string> = {};
    new ApiVersionMiddleware().use({ originalUrl: url }, { setHeader: (k, v) => void (headers[k] = v) }, () => undefined);
    return headers;
  };

  it("marks unversioned API paths as deprecated and points at the versioned URL", () => {
    expect(headersFor("/devices/d1/commands?x=1")).toEqual({
      Deprecation: "true",
      Link: '</v1/devices/d1/commands>; rel="successor-version"',
    });
  });

  it.each(["/v1/devices", "/v1", "/v2/anything", "/health", "/health/ready", "/metrics"])("leaves %s alone", (url) => {
    expect(headersFor(url)).toEqual({});
  });
});
