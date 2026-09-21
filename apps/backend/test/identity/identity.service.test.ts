import { describe, expect, it, beforeEach } from "vitest";
import { HttpException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import type { Repository } from "typeorm";
import { IdentityService } from "../../src/identity/identity.service";
import { User } from "../../src/identity/user.entity";
import { LoginThrottle, MAX_FAILURES_PER_ACCOUNT } from "../../src/identity/login-throttle";
import { envSchema } from "../../src/config/env.validation";
import { fakeUserRepo } from "../helpers/fake-user-repo";

describe("IdentityService", () => {
  let repo: Repository<User>;
  let jwt: JwtService;
  let service: IdentityService;

  beforeEach(() => {
    repo = fakeUserRepo();
    jwt = new JwtService({ secret: "test-secret-at-least-16-chars" });
    service = new IdentityService(repo, jwt, undefined, new LoginThrottle());
  });

  it("registers the first admin and issues a verifiable token", async () => {
    const result = await service.register("admin@example.com", "correct horse battery");
    expect(result.user).toEqual({ id: expect.any(String), email: "admin@example.com", role: "admin" });

    const payload = await jwt.verifyAsync(result.accessToken);
    expect(payload).toMatchObject({ email: "admin@example.com", role: "admin" });
  });

  it("refuses a second registration once an admin exists (bootstrap-only)", async () => {
    await service.register("admin@example.com", "correct horse battery");
    await expect(service.register("second@example.com", "another password")).rejects.toThrow(
      /Registration is closed/,
    );
  });

  it("logs in with correct credentials and rejects wrong ones", async () => {
    await service.register("admin@example.com", "correct horse battery");

    const ok = await service.login("admin@example.com", "correct horse battery");
    expect(ok.user.email).toBe("admin@example.com");

    await expect(service.login("admin@example.com", "wrong password")).rejects.toThrow(/Invalid email or password/);
    await expect(service.login("nobody@example.com", "whatever")).rejects.toThrow(/Invalid email or password/);
  });

  it("never stores the plaintext password", async () => {
    const result = await service.register("admin@example.com", "correct horse battery");
    const stored = await repo.findOne({ where: { email: "admin@example.com" } } as never);
    expect(stored?.passwordHash).not.toBe("correct horse battery");
    expect(stored?.passwordHash).toMatch(/^\$2[aby]\$/); // bcrypt hash prefix
    expect(result.user).not.toHaveProperty("passwordHash");
  });
});

describe("IdentityService first-admin bootstrap hardening (audit I1)", () => {
  const TOKEN = "bootstrap-secret-0123456789";
  let repo: Repository<User>;
  let jwt: JwtService;

  beforeEach(() => {
    repo = fakeUserRepo();
    jwt = new JwtService({ secret: "test-secret-at-least-16-chars" });
  });

  it("creates exactly one admin when two first registrations race", async () => {
    const service = new IdentityService(repo, jwt, undefined, new LoginThrottle());
    const results = await Promise.allSettled([
      service.register("a@example.com", "correct horse battery"),
      service.register("b@example.com", "correct horse battery"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(await repo.count()).toBe(1);
  });

  it("requires the bootstrap token when one is configured", async () => {
    const service = new IdentityService(repo, jwt, TOKEN, new LoginThrottle());
    await expect(service.register("a@example.com", "correct horse battery")).rejects.toThrow(/bootstrap token/);
    await expect(service.register("a@example.com", "correct horse battery", "wrong")).rejects.toThrow(
      /bootstrap token/,
    );
    expect(await repo.count()).toBe(0);

    const ok = await service.register("a@example.com", "correct horse battery", TOKEN);
    expect(ok.user.email).toBe("a@example.com");
  });

  it("does not require a token when none is configured (development)", async () => {
    const service = new IdentityService(repo, jwt, undefined, new LoginThrottle());
    await expect(service.register("a@example.com", "correct horse battery")).resolves.toBeDefined();
  });

  it("env validation requires ADMIN_BOOTSTRAP_TOKEN in production only", () => {
    const base = { DATABASE_URL: "postgres://u:p@localhost:5432/db", JWT_SECRET: "0123456789abcdef-jwt" };
    expect(envSchema.safeParse({ ...base, NODE_ENV: "production" }).success).toBe(false);
    expect(envSchema.safeParse({ ...base, NODE_ENV: "production", ADMIN_BOOTSTRAP_TOKEN: TOKEN }).success).toBe(true);
    expect(envSchema.safeParse({ ...base, NODE_ENV: "development" }).success).toBe(true);
    expect(envSchema.safeParse({ ...base, ADMIN_BOOTSTRAP_TOKEN: "short" }).success).toBe(false);
  });
});

describe("IdentityService login throttling (audit I2)", () => {
  let service: IdentityService;

  beforeEach(async () => {
    const repo = fakeUserRepo();
    const jwt = new JwtService({ secret: "test-secret-at-least-16-chars" });
    service = new IdentityService(repo, jwt, undefined, new LoginThrottle());
    await service.register("admin@example.com", "correct horse battery");
  });

  it("locks the account after repeated failures, even for the correct password", async () => {
    for (let i = 0; i < MAX_FAILURES_PER_ACCOUNT; i++) {
      await expect(service.login("admin@example.com", "wrong", "10.0.0.1")).rejects.toThrow(/Invalid email or password/);
    }
    const blocked = await service.login("admin@example.com", "correct horse battery", "10.0.0.1").catch((e) => e);
    expect(blocked).toBeInstanceOf(HttpException);
    expect((blocked as HttpException).getStatus()).toBe(429);
  });

  it("also throttles attempts against an account that does not exist", async () => {
    for (let i = 0; i < MAX_FAILURES_PER_ACCOUNT; i++) {
      await expect(service.login("ghost@example.com", "x", "10.0.0.2")).rejects.toThrow(/Invalid email/);
    }
    const blocked = await service.login("ghost@example.com", "x", "10.0.0.2").catch((e) => e);
    expect((blocked as HttpException).getStatus()).toBe(429);
  });

  it("a successful login clears the account counter", async () => {
    for (let i = 0; i < MAX_FAILURES_PER_ACCOUNT - 1; i++) {
      await expect(service.login("admin@example.com", "wrong", "10.0.0.3")).rejects.toThrow();
    }
    await expect(service.login("admin@example.com", "correct horse battery", "10.0.0.3")).resolves.toBeDefined();
    await expect(service.login("admin@example.com", "wrong", "10.0.0.3")).rejects.toThrow(/Invalid email/);
  });
});
