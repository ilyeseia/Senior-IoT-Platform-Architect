import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ANY_AUTHENTICATED_KEY, IS_PUBLIC_KEY, PERMISSIONS, PERMISSION_KEY } from "../../src/platform";

/**
 * Every HTTP route must state who may call it: @Public(), @AnyAuthenticated() or
 * @RequirePermission(<known permission>) — on the handler or its controller. PermissionsGuard
 * refuses an unannotated route at runtime (fail closed); this test makes sure none is ever shipped
 * that way, and that a permission name typo cannot silently lock everyone out.
 */
const SRC = resolve(__dirname, "../../src");
const PATH_METADATA = "path"; // @nestjs/common's route path metadata key
const METHOD_METADATA = "method";

function controllerFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? controllerFiles(full) : name.endsWith(".controller.ts") ? [full] : [];
  });
}

interface Route {
  where: string;
  publicRoute: boolean;
  anyAuth: boolean;
  permission: unknown;
}

async function collectRoutes(): Promise<Route[]> {
  const routes: Route[] = [];
  for (const file of controllerFiles(SRC)) {
    const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
    for (const [exportName, cls] of Object.entries(mod)) {
      if (typeof cls !== "function" || Reflect.getMetadata(PATH_METADATA, cls) === undefined) continue; // not a @Controller
      const proto = (cls as { prototype: Record<string, unknown> }).prototype;
      for (const method of Object.getOwnPropertyNames(proto)) {
        const handler = proto[method];
        if (method === "constructor" || typeof handler !== "function") continue;
        if (Reflect.getMetadata(METHOD_METADATA, handler) === undefined) continue; // not a route handler
        const meta = (key: string) => Reflect.getMetadata(key, handler) ?? Reflect.getMetadata(key, cls);
        routes.push({
          where: `${exportName}.${method}`,
          publicRoute: meta(IS_PUBLIC_KEY) === true,
          anyAuth: meta(ANY_AUTHENTICATED_KEY) === true,
          permission: meta(PERMISSION_KEY),
        });
      }
    }
  }
  return routes;
}

describe("route permissions", () => {
  it("finds the routes (guard against a vacuous test)", async () => {
    const routes = await collectRoutes();
    expect(routes.length).toBeGreaterThanOrEqual(20);
    expect(routes.some((r) => r.where === "UsersController.create")).toBe(true);
  });

  it("every route declares exactly one of @Public, @AnyAuthenticated or @RequirePermission", async () => {
    const routes = await collectRoutes();
    const undeclared = routes.filter((r) => !r.publicRoute && !r.anyAuth && r.permission === undefined).map((r) => r.where);
    const ambiguous = routes
      .filter((r) => [r.publicRoute, r.anyAuth, r.permission !== undefined].filter(Boolean).length > 1)
      .map((r) => r.where);
    expect(undeclared, "add @RequirePermission(...) (or @Public / @AnyAuthenticated) to these routes").toEqual([]);
    expect(ambiguous).toEqual([]);
  });

  it("every declared permission is a real one", async () => {
    const bad = (await collectRoutes())
      .filter((r) => r.permission !== undefined && !(PERMISSIONS as readonly string[]).includes(r.permission as string))
      .map((r) => `${r.where}: ${String(r.permission)}`);
    expect(bad).toEqual([]);
  });

  it("only the intended routes are public", async () => {
    const publicRoutes = (await collectRoutes()).filter((r) => r.publicRoute).map((r) => r.where).sort();
    expect(publicRoutes).toEqual([
      "HealthController.check",
      "HealthController.live",
      "HealthController.ready",
      "IdentityController.login",
      "IdentityController.register",
    ]);
  });

  it("sensitive areas require the expected permission", async () => {
    const by = Object.fromEntries((await collectRoutes()).map((r) => [r.where, r.permission]));
    expect(by["AuditController.events"]).toBe("audit:read");
    expect(by["MetricsController.scrape"]).toBe("metrics:read");
    expect(by["CommandsController.dispatch"]).toBe("commands:dispatch");
    expect(by["TwinController.setDesired"]).toBe("twin:write");
    expect(by["UsersController.create"]).toBe("users:manage");
    expect(by["UsersController.update"]).toBe("users:manage");
    expect(by["UsersController.resetPassword"]).toBe("users:manage");
    expect(by["ProvisioningController.execute"]).toBe("devices:privileged");
    expect(by["ProvisioningController.targets"]).toBe("devices:privileged");
  });
});
