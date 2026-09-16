import "reflect-metadata";
import { describe, expect, it, beforeEach } from "vitest";
import { ExecutionContext, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import { JwtAuthGuard } from "../../src/identity/jwt-auth.guard";
import { IS_PUBLIC_KEY } from "../../src/identity/public.decorator";

function fakeContext(authorization: string | undefined, isPublic: boolean): ExecutionContext {
  const handler = () => undefined;
  if (isPublic) {
    Reflect.defineMetadata(IS_PUBLIC_KEY, true, handler);
  }
  const request: { headers: { authorization?: string }; user?: unknown } = {
    headers: { authorization },
  };
  return {
    getHandler: () => handler,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe("JwtAuthGuard", () => {
  let jwt: JwtService;
  let guard: JwtAuthGuard;

  beforeEach(() => {
    jwt = new JwtService({ secret: "test-secret-at-least-16-chars" });
    guard = new JwtAuthGuard(new Reflector(), jwt);
  });

  it("allows a @Public() route through with no token at all", async () => {
    await expect(guard.canActivate(fakeContext(undefined, true))).resolves.toBe(true);
  });

  it("rejects a protected route with no Authorization header", async () => {
    await expect(guard.canActivate(fakeContext(undefined, false))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it("rejects a malformed Authorization header (not 'Bearer <token>')", async () => {
    await expect(guard.canActivate(fakeContext("Basic abc123", false))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it("rejects an invalid/tampered token", async () => {
    await expect(
      guard.canActivate(fakeContext("Bearer not-a-real-token", false)),
    ).rejects.toThrow(UnauthorizedException);
  });

  it("rejects a token signed with a different secret", async () => {
    const otherJwt = new JwtService({ secret: "a-completely-different-secret-16" });
    const token = await otherJwt.signAsync({ sub: "1", email: "x@example.com", role: "admin" });
    await expect(guard.canActivate(fakeContext(`Bearer ${token}`, false))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it("accepts a valid token and attaches its payload to the request", async () => {
    const token = await jwt.signAsync({ sub: "u1", email: "admin@example.com", role: "admin" });
    const context = fakeContext(`Bearer ${token}`, false);
    await expect(guard.canActivate(context)).resolves.toBe(true);

    const request = context.switchToHttp().getRequest<{ user?: { email: string } }>();
    expect(request.user?.email).toBe("admin@example.com");
  });
});
