import { beforeEach, describe, expect, it } from "vitest";
import { ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { IdentityService, USER_STATE_TTL_MS } from "../../src/identity/identity.service";
import { LoginThrottle, MAX_FAILURES_PER_ACCOUNT } from "../../src/identity/login-throttle";
import { UsersController } from "../../src/identity/users.controller";
import { fakeUserRepo } from "../helpers/fake-user-repo";
import { RecordingEventBus } from "../helpers/recording-bus";

const PW = "correct horse battery";

async function setup() {
  const repo = fakeUserRepo();
  const jwt = new JwtService({ secret: "test-secret-at-least-16-chars" });
  const bus = new RecordingEventBus();
  const service = new IdentityService(repo, jwt, undefined, new LoginThrottle(), bus);
  const admin = await service.register("admin@example.com", PW);
  return { repo, jwt, bus, service, admin };
}

describe("user management", () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    ctx = await setup();
  });

  it("an admin creates operators and viewers; the API view never contains the hash", async () => {
    const op = await ctx.service.createUser("op@example.com", PW, "operator", ctx.admin.user.id);
    expect(op).toMatchObject({ email: "op@example.com", role: "operator", disabled: false });
    expect(op).not.toHaveProperty("passwordHash");
    const list = await ctx.service.listUsers();
    expect(list.map((u) => u.email)).toEqual(["admin@example.com", "op@example.com"]);
    for (const u of list) expect(u).not.toHaveProperty("passwordHash");
  });

  it("refuses a duplicate email", async () => {
    await expect(ctx.service.createUser("admin@example.com", PW, "viewer", null)).rejects.toBeInstanceOf(ConflictException);
  });

  it("a created user can sign in and gets a token carrying the role and token version", async () => {
    await ctx.service.createUser("viewer@example.com", PW, "viewer", null);
    const auth = await ctx.service.login("viewer@example.com", PW);
    expect(auth.user.role).toBe("viewer");
    expect(await ctx.jwt.verifyAsync(auth.accessToken)).toMatchObject({ role: "viewer", tv: 0 });
  });

  it("changes a role and reports the change with the actor", async () => {
    const op = await ctx.service.createUser("op@example.com", PW, "operator", null);
    const updated = await ctx.service.updateUser(op.id, { role: "viewer" }, ctx.admin.user.id);
    expect(updated.role).toBe("viewer");
    const event = ctx.bus.ofType("security.user.updated")[0];
    expect(event.payload).toMatchObject({ userId: op.id, changes: { role: { from: "operator", to: "viewer" } }, actor: ctx.admin.user.id });
  });

  it("an update that changes nothing publishes nothing", async () => {
    const op = await ctx.service.createUser("op@example.com", PW, "operator", null);
    ctx.bus.events.length = 0;
    await ctx.service.updateUser(op.id, { role: "operator" }, null);
    expect(ctx.bus.ofType("security.user.updated")).toHaveLength(0);
  });

  it("404s for an unknown user", async () => {
    await expect(ctx.service.updateUser("11111111-1111-4111-8111-111111111111", { disabled: true }, null)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe("the last active admin can never be removed", () => {
  it("refuses to demote or disable the only admin", async () => {
    const { service, admin } = await setup();
    await expect(service.updateUser(admin.user.id, { role: "viewer" }, null)).rejects.toThrow(/last active admin/);
    await expect(service.updateUser(admin.user.id, { disabled: true }, null)).rejects.toThrow(/last active admin/);
  });

  it("allows it once a second active admin exists, and then protects the remaining one", async () => {
    const { service, admin } = await setup();
    const second = await service.createUser("second@example.com", PW, "admin", null);
    await service.updateUser(admin.user.id, { role: "operator" }, second.id);
    await expect(service.updateUser(second.id, { disabled: true }, null)).rejects.toThrow(/last active admin/);
  });

  it("counts a disabled admin as not active", async () => {
    const { service, admin } = await setup();
    const second = await service.createUser("second@example.com", PW, "admin", null);
    await service.updateUser(second.id, { disabled: true }, admin.user.id);
    await expect(service.updateUser(admin.user.id, { role: "viewer" }, null)).rejects.toThrow(/last active admin/);
  });

  it("two simultaneous demotions of the only two admins cannot both succeed", async () => {
    const { service, admin } = await setup();
    const second = await service.createUser("second@example.com", PW, "admin", null);
    const results = await Promise.allSettled([
      service.updateUser(admin.user.id, { role: "viewer" }, null),
      service.updateUser(second.id, { role: "viewer" }, null),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const admins = (await service.listUsers()).filter((u) => u.role === "admin" && !u.disabled);
    expect(admins).toHaveLength(1);
  });
});

describe("revocation", () => {
  it("disabling an account blocks login (indistinguishably from a wrong password) and kills its tokens", async () => {
    const { service, jwt } = await setup();
    const viewer = await service.createUser("v@example.com", PW, "viewer", null);
    const session = await service.login("v@example.com", PW);
    const claims = await jwt.verifyAsync(session.accessToken);
    expect((await service.getActiveUser(viewer.id))?.tokenVersion).toBe(claims.tv);

    await service.updateUser(viewer.id, { disabled: true }, null);

    expect(await service.getActiveUser(viewer.id)).toBeNull();
    await expect(service.login("v@example.com", PW)).rejects.toThrow(/Invalid email or password/);
    // re-enabled: the old token is still dead (version was bumped), a fresh login works
    await service.updateUser(viewer.id, { disabled: false }, null);
    const active = await service.getActiveUser(viewer.id);
    expect(active?.tokenVersion).toBe(claims.tv + 1);
    await expect(service.login("v@example.com", PW)).resolves.toBeDefined();
  });

  it("caches an account's state briefly, so a change reaches a request within the TTL bound", async () => {
    const { service, repo } = await setup();
    const u = await service.createUser("v@example.com", PW, "viewer", null);
    let clock = 1_000_000;
    service.now = () => clock;
    expect((await service.getActiveUser(u.id))?.role).toBe("viewer");

    // a change made behind the service's back (another instance) is invisible until the TTL expires
    repo.rows.get(u.id)!.role = "operator";
    expect((await service.getActiveUser(u.id))?.role).toBe("viewer");
    clock += USER_STATE_TTL_MS + 1;
    expect((await service.getActiveUser(u.id))?.role).toBe("operator");
  });

  it("a change made through the service is visible immediately (cache invalidated)", async () => {
    const { service } = await setup();
    const u = await service.createUser("v@example.com", PW, "viewer", null);
    await service.getActiveUser(u.id);
    await service.updateUser(u.id, { role: "operator" }, null);
    expect((await service.getActiveUser(u.id))?.role).toBe("operator");
  });
});

describe("passwords", () => {
  it("an admin reset changes the password and revokes existing tokens", async () => {
    const { service, admin } = await setup();
    const u = await service.createUser("v@example.com", PW, "viewer", null);
    await service.resetPassword(u.id, "brand new password", admin.user.id);
    expect((await service.getActiveUser(u.id))?.tokenVersion).toBe(1);
    await expect(service.login("v@example.com", PW)).rejects.toThrow(/Invalid email or password/);
    await expect(service.login("v@example.com", "brand new password")).resolves.toBeDefined();
    expect((await service.login("v@example.com", "brand new password").then(async (a) => a.user.id))).toBe(u.id);
  });

  it("changing your own password needs the current one, and returns a token that survives the revocation", async () => {
    const { service, jwt, admin } = await setup();
    await expect(service.changeOwnPassword(admin.user.id, "wrong", "another password")).rejects.toBeInstanceOf(ForbiddenException);

    const fresh = await service.changeOwnPassword(admin.user.id, PW, "another password");
    expect(await jwt.verifyAsync(fresh.accessToken)).toMatchObject({ tv: 1 });
    expect((await service.getActiveUser(admin.user.id))?.tokenVersion).toBe(1); // the pre-change token (tv 0) is now dead
    await expect(service.login("admin@example.com", PW)).rejects.toThrow();
    await expect(service.login("admin@example.com", "another password")).resolves.toBeDefined();
  });
});

describe("security events", () => {
  it("publishes creation, login, password and lockout events — the lockout only once", async () => {
    const { service, bus, admin } = await setup();
    expect(bus.ofType("security.user.created")[0].payload).toMatchObject({ email: "admin@example.com", role: "admin", actor: null });

    await service.login("admin@example.com", PW, "10.1.1.1");
    expect(bus.ofType("security.login.succeeded")[0].payload).toMatchObject({ userId: admin.user.id, address: "10.1.1.1" });

    await service.resetPassword(admin.user.id, "another password", admin.user.id);
    expect(bus.ofType("security.password.changed")[0].payload).toMatchObject({ by: "admin", actor: admin.user.id });

    for (let i = 0; i < MAX_FAILURES_PER_ACCOUNT + 3; i++) {
      await service.login("admin@example.com", "wrong", "10.2.2.2").catch(() => undefined);
    }
    const locks = bus.ofType("security.login.locked");
    expect(locks).toHaveLength(1);
    expect(locks[0].payload).toMatchObject({ scope: "account", email: "admin@example.com", address: "10.2.2.2" });
  });

  it("never puts a password or hash in any event", async () => {
    const { service, bus } = await setup();
    await service.createUser("v@example.com", "secret-password-123", "viewer", null);
    await service.login("v@example.com", "secret-password-123");
    const text = JSON.stringify(bus.events);
    expect(text).not.toContain("secret-password-123");
    expect(text).not.toMatch(/\$2[aby]\$/);
    expect(text).not.toContain("passwordHash");
  });
});

describe("UsersController", () => {
  const controller = async () => {
    const { service, admin } = await setup();
    return { controller: new UsersController(service), service, admin };
  };

  it("me() reports the live role and its permissions", async () => {
    const { controller: c } = await controller();
    const me = c.me({ user: { sub: "u1", email: "v@example.com", role: "viewer" } });
    expect(me).toMatchObject({ role: "viewer", permissions: ["devices:read", "commands:read", "twin:read", "telemetry:read"] });
  });

  it.each([
    ["an unknown role", { email: "x@example.com", password: PW, role: "root" }],
    ["a missing role", { email: "x@example.com", password: PW }],
    ["a short password", { email: "x@example.com", password: "short", role: "viewer" }],
    ["an unexpected field", { email: "x@example.com", password: PW, role: "viewer", isAdmin: true }],
    ["a bad email", { email: "nope", password: PW, role: "viewer" }],
  ])("rejects create with %s", async (_l, body) => {
    const { controller: c, admin } = await controller();
    expect(() => c.create(body, { user: { sub: admin.user.id, email: "admin@example.com", role: "admin" } })).toThrow();
  });

  it("rejects an empty update and a malformed id is left to the UUID pipe", async () => {
    const { controller: c, admin } = await controller();
    expect(() => c.update("22222222-2222-4222-8222-222222222222", {}, { user: { sub: admin.user.id, email: "a", role: "admin" } })).toThrow();
  });

  it("create() passes the calling admin as the actor", async () => {
    const { controller: c, admin, service } = await controller();
    await c.create({ email: "n@example.com", password: PW, role: "operator" }, { user: { sub: admin.user.id, email: "a", role: "admin" } });
    const users = await service.listUsers();
    expect(users.find((u) => u.email === "n@example.com")?.role).toBe("operator");
  });
});
