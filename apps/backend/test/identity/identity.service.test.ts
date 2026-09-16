import { describe, expect, it, beforeEach } from "vitest";
import { JwtService } from "@nestjs/jwt";
import type { Repository } from "typeorm";
import { IdentityService } from "../../src/identity/identity.service";
import { User } from "../../src/identity/user.entity";

/**
 * A minimal in-memory stand-in for Repository<User> — only the methods
 * IdentityService actually calls (count/findOne/create/save) — rather than a
 * deep mock of TypeORM's full Repository surface. Matches this codebase's
 * existing preference for real collaborators over mocking frameworks
 * (mqtt.service.integration.test.ts uses a real aedes broker for the same
 * reason).
 */
function fakeUserRepo(): Repository<User> {
  const rows: User[] = [];
  return {
    count: async () => rows.length,
    findOne: async ({ where }: { where: { email: string } }) =>
      rows.find((r) => r.email === where.email) ?? null,
    create: (partial: Partial<User>) => partial as User,
    save: async (user: User) => {
      const withId = { ...user, id: user.id ?? `user-${rows.length + 1}`, createdAt: new Date() };
      rows.push(withId);
      return withId;
    },
  } as unknown as Repository<User>;
}

describe("IdentityService", () => {
  let repo: Repository<User>;
  let jwt: JwtService;
  let service: IdentityService;

  beforeEach(() => {
    repo = fakeUserRepo();
    jwt = new JwtService({ secret: "test-secret-at-least-16-chars" });
    service = new IdentityService(repo, jwt);
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

    await expect(service.login("admin@example.com", "wrong password")).rejects.toThrow(
      /Invalid email or password/,
    );
    await expect(service.login("nobody@example.com", "whatever")).rejects.toThrow(
      /Invalid email or password/,
    );
  });

  it("never stores the plaintext password", async () => {
    const result = await service.register("admin@example.com", "correct horse battery");
    // Reach into the fake repo the same way Postgres would store it.
    const stored = await repo.findOne({ where: { email: "admin@example.com" } } as never);
    expect(stored?.passwordHash).not.toBe("correct horse battery");
    expect(stored?.passwordHash).toMatch(/^\$2[aby]\$/); // bcrypt hash prefix
    expect(result.user).not.toHaveProperty("passwordHash");
  });
});
