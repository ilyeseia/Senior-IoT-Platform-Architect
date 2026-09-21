import { describe, expect, it } from "vitest";
import { ForbiddenException, UnauthorizedException } from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AnyAuthenticated, Public, RequirePermission, ROLES, PERMISSIONS, permissionsFor, roleHasPermission } from "../../src/platform";
import { PermissionsGuard } from "../../src/identity/permissions.guard";
import type { IdentityService, JwtPayload } from "../../src/identity/identity.service";
import type { User } from "../../src/identity/user.entity";

describe("role -> permission matrix", () => {
  it.each([
    ["viewer", "devices:read", true],
    ["viewer", "commands:read", true],
    ["viewer", "twin:read", true],
    ["viewer", "telemetry:read", true],
    ["viewer", "commands:dispatch", false],
    ["viewer", "twin:write", false],
    ["viewer", "devices:write", false],
    ["viewer", "audit:read", false],
    ["viewer", "metrics:read", false],
    ["viewer", "users:manage", false],
    ["viewer", "devices:privileged", false],
    ["operator", "commands:dispatch", true],
    ["operator", "twin:write", true],
    ["operator", "devices:write", true],
    ["operator", "audit:read", false],
    ["operator", "metrics:read", false],
    ["operator", "users:manage", false],
    ["operator", "devices:privileged", false],
    ["admin", "devices:privileged", true],
    ["admin", "users:manage", true],
    ["admin", "audit:read", true],
    ["admin", "metrics:read", true],
  ] as const)("%s %s => %s", (role, permission, expected) => {
    expect(roleHasPermission(role, permission)).toBe(expected);
  });

  it("admin holds every permission and viewer is a strict subset of operator", () => {
    expect([...permissionsFor("admin")].sort()).toEqual([...PERMISSIONS].sort());
    for (const p of permissionsFor("viewer")) expect(permissionsFor("operator")).toContain(p);
  });

  it("an unknown or empty role has no permissions (fail closed)", () => {
    expect(permissionsFor("superuser")).toEqual([]);
    expect(permissionsFor("")).toEqual([]);
    expect(ROLES).toEqual(["admin", "operator", "viewer"]);
  });
});

/** A fake controller whose routes are annotated the way real ones are. */
class Sample {
  publicRoute() {}
  readRoute() {}
  adminRoute() {}
  selfRoute() {}
  undeclaredRoute() {}
}
const annotate = (method: keyof Sample, decorator: MethodDecorator) =>
  decorator(Sample.prototype, method, Object.getOwnPropertyDescriptor(Sample.prototype, method)!);
annotate("publicRoute", Public());
annotate("readRoute", RequirePermission("devices:read"));
annotate("adminRoute", RequirePermission("devices:privileged"));
annotate("selfRoute", AnyAuthenticated());

function contextFor(method: keyof Sample, user?: JwtPayload) {
  const request: { user?: JwtPayload } = { user };
  const ctx = {
    getHandler: () => Sample.prototype[method],
    getClass: () => Sample,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { ctx, request };
}

const account = (over: Partial<User> = {}): User =>
  ({ id: "u1", email: "a@b.c", role: "admin", disabledAt: null, tokenVersion: 0, ...over }) as User;

function guardFor(active: User | null) {
  const identity = { getActiveUser: async () => active } as unknown as IdentityService;
  return new PermissionsGuard(new Reflector(), identity);
}
const claims = (over: Partial<JwtPayload> = {}): JwtPayload => ({ sub: "u1", email: "a@b.c", role: "admin", tv: 0, ...over });

describe("PermissionsGuard", () => {
  it("lets a @Public route through without looking at the user", async () => {
    await expect(guardFor(null).canActivate(contextFor("publicRoute").ctx)).resolves.toBe(true);
  });

  it("refuses a request that carries no verified claims", async () => {
    await expect(guardFor(account()).canActivate(contextFor("readRoute").ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("refuses a token whose account was disabled or deleted", async () => {
    await expect(guardFor(null).canActivate(contextFor("readRoute", claims()).ctx)).rejects.toThrow(/disabled or no longer exists/);
  });

  it("refuses a revoked token (older tokenVersion) and treats a missing tv as 0", async () => {
    const revoked = contextFor("readRoute", claims({ tv: 0 }));
    await expect(guardFor(account({ tokenVersion: 1 })).canActivate(revoked.ctx)).rejects.toThrow(/revoked/);

    const legacy = contextFor("readRoute", claims({ tv: undefined }));
    await expect(guardFor(account({ tokenVersion: 0 })).canActivate(legacy.ctx)).resolves.toBe(true);
    await expect(guardFor(account({ tokenVersion: 2 })).canActivate(contextFor("readRoute", claims({ tv: 2 })).ctx)).resolves.toBe(true);
  });

  it("decides with the account's CURRENT role, not the role inside the token", async () => {
    // The token still says admin, but the account was demoted to viewer since.
    const { ctx } = contextFor("adminRoute", claims({ role: "admin" }));
    await expect(guardFor(account({ role: "viewer" })).canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
    const read = contextFor("readRoute", claims({ role: "admin" }));
    await guardFor(account({ role: "viewer" })).canActivate(read.ctx);
    expect(read.request.user?.role).toBe("viewer"); // handlers and audit see the live role
  });

  it("allows what the role grants and refuses what it does not", async () => {
    await expect(guardFor(account({ role: "viewer" })).canActivate(contextFor("readRoute", claims()).ctx)).resolves.toBe(true);
    await expect(guardFor(account({ role: "viewer" })).canActivate(contextFor("adminRoute", claims()).ctx)).rejects.toThrow(
      /Requires the devices:privileged permission/,
    );
    await expect(guardFor(account({ role: "operator" })).canActivate(contextFor("adminRoute", claims()).ctx)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(guardFor(account({ role: "admin" })).canActivate(contextFor("adminRoute", claims()).ctx)).resolves.toBe(true);
  });

  it("lets any signed-in user reach an @AnyAuthenticated route, but still revokes disabled accounts", async () => {
    await expect(guardFor(account({ role: "viewer" })).canActivate(contextFor("selfRoute", claims()).ctx)).resolves.toBe(true);
    await expect(guardFor(null).canActivate(contextFor("selfRoute", claims()).ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("refuses a route that declares nothing (fail closed)", async () => {
    await expect(guardFor(account()).canActivate(contextFor("undeclaredRoute", claims()).ctx)).rejects.toThrow(
      /no permission declared/,
    );
  });

  it("refuses an account with an unrecognised role even on a read route", async () => {
    await expect(
      guardFor(account({ role: "superuser" as never })).canActivate(contextFor("readRoute", claims()).ctx),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
