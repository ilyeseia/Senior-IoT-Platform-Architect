import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  UnauthorizedException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { JwtService } from "@nestjs/jwt";
import { compare, hash } from "bcryptjs";
import { createHash, timingSafeEqual } from "crypto";
import { Repository } from "typeorm";
import { EVENT_BUS, EventTypes, createEvent } from "../platform";
import type {
  EventBus,
  LoginLockedPayload,
  LoginSucceededPayload,
  PasswordChangedPayload,
  Role,
  UserCreatedPayload,
  UserUpdatedPayload,
} from "../platform";
import { LoginThrottle } from "./login-throttle";
import { User } from "./user.entity";

const BCRYPT_ROUNDS = 12;
/**
 * A real bcrypt hash (computed once, lazily) that is compared against when the email is unknown,
 * so an unknown account costs as much time as a wrong password. It must be a valid hash: bcryptjs
 * returns false immediately for a malformed one, which would defeat the purpose.
 */
let dummyHash: Promise<string> | undefined;
function getDummyHash(): Promise<string> {
  dummyHash ??= hash("timing-equalisation-only", BCRYPT_ROUNDS);
  return dummyHash;
}
/** Arbitrary constant used as the Postgres advisory-lock key that serialises account-set changes (first admin, last-admin rule). */
const BOOTSTRAP_LOCK_KEY = 7_301_001;
/** How long a user's role/disabled/token-version state is cached per request path. Bounds how late a revocation reaches another instance. */
export const USER_STATE_TTL_MS = 10_000;

/** DI token for the optional first-admin bootstrap secret (ADMIN_BOOTSTRAP_TOKEN). */
export const ADMIN_BOOTSTRAP_TOKEN = "ADMIN_BOOTSTRAP_TOKEN";

export interface JwtPayload {
  sub: string;
  email: string;
  role: string;
  /** Token version; absent on tokens issued before revocation existed (treated as 0). */
  tv?: number;
}

export interface AuthResult {
  accessToken: string;
  user: { id: string; email: string; role: string };
}

/** What the API shows about an account — never the hash. */
export interface UserView {
  id: string;
  email: string;
  role: Role;
  disabled: boolean;
  createdAt: Date;
}

export function toUserView(u: User): UserView {
  return { id: u.id, email: u.email, role: u.role, disabled: u.disabledAt !== null && u.disabledAt !== undefined, createdAt: u.createdAt };
}

@Injectable()
export class IdentityService {
  private readonly stateCache = new Map<string, { user: User | null; at: number }>();
  /** Clock for the state cache; a plain field so tests can move time. */
  now: () => number = Date.now;

  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly jwt: JwtService,
    @Optional() @Inject(ADMIN_BOOTSTRAP_TOKEN) private readonly bootstrapToken?: string,
    @Optional() private readonly throttle: LoginThrottle = new LoginThrottle(),
    @Optional() @Inject(EVENT_BUS) private readonly bus?: EventBus,
  ) {}

  /**
   * First-admin bootstrap (Architecture Evolution §22): registration is only allowed while the
   * `users` table is empty; once one user exists it always rejects and further accounts are
   * created by an admin through createUser().
   *
   * Two hardening rules (audit I1):
   *  - the check-and-insert runs in one transaction under a Postgres advisory lock, so two
   *    concurrent first requests cannot both see an empty table and create two admins;
   *  - when ADMIN_BOOTSTRAP_TOKEN is configured, the caller must present it, so "whoever reaches
   *    a fresh deployment first becomes admin" is no longer true. (Required in production by
   *    env validation; optional in development.)
   */
  async register(email: string, password: string, bootstrapToken?: string): Promise<AuthResult> {
    this.assertBootstrapToken(bootstrapToken);
    const passwordHash = await hash(password, BCRYPT_ROUNDS);

    const user = await this.users.manager.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock($1)", [BOOTSTRAP_LOCK_KEY]);
      if ((await tx.count(User)) > 0) {
        throw new ConflictException(
          "Registration is closed — an admin user already exists. Ask an existing admin.",
        );
      }
      return tx.save(tx.create(User, { email, passwordHash, role: "admin" }));
    });
    this.publish<UserCreatedPayload>(EventTypes.SECURITY_USER_CREATED, {
      userId: user.id,
      email: user.email,
      role: user.role,
      actor: null,
    });
    return this.issueToken(user);
  }

  async login(email: string, password: string, clientAddress = "unknown"): Promise<AuthResult> {
    this.throttle.assertAllowed(email, clientAddress);

    const user = await this.users.findOne({ where: { email } });
    // Always run one bcrypt comparison — with a dummy hash when the account does not exist — so
    // response time does not reveal which emails are registered.
    const valid = await compare(password, user?.passwordHash ?? (await getDummyHash()));
    // A disabled account is indistinguishable from a wrong password (no account state leaks).
    if (!user || !valid || user.disabledAt) {
      const locked = this.throttle.recordFailure(email, clientAddress);
      if (locked.account || locked.address) {
        this.publish<LoginLockedPayload>(EventTypes.SECURITY_LOGIN_LOCKED, {
          scope: locked.account ? "account" : "address",
          email,
          address: clientAddress,
        });
      }
      throw new UnauthorizedException("Invalid email or password");
    }
    this.throttle.recordSuccess(email);
    this.publish<LoginSucceededPayload>(EventTypes.SECURITY_LOGIN_SUCCEEDED, {
      userId: user.id,
      email: user.email,
      address: clientAddress,
    });
    return this.issueToken(user);
  }

  /**
   * The account behind a token, as it is NOW — role, enabled state and token version are read from
   * the database (cached briefly), not trusted from the JWT. This is what makes demoting or
   * disabling someone effective within USER_STATE_TTL_MS instead of after the token's 12 hours.
   * Returns null when the account is gone or disabled.
   */
  async getActiveUser(id: string): Promise<User | null> {
    const cached = this.stateCache.get(id);
    if (cached && this.now() - cached.at < USER_STATE_TTL_MS) {
      return cached.user;
    }
    const row = await this.users.findOne({ where: { id } });
    const user = row && !row.disabledAt ? row : null;
    this.stateCache.set(id, { user, at: this.now() });
    return user;
  }

  async listUsers(): Promise<UserView[]> {
    const rows = await this.users.find({ order: { createdAt: "ASC" } });
    return rows.map(toUserView);
  }

  async createUser(email: string, password: string, role: Role, actor: string | null): Promise<UserView> {
    const passwordHash = await hash(password, BCRYPT_ROUNDS);
    const existing = await this.users.findOne({ where: { email } });
    if (existing) {
      throw new ConflictException("A user with this email already exists");
    }
    const user = await this.users.save(this.users.create({ email, passwordHash, role }));
    this.publish<UserCreatedPayload>(EventTypes.SECURITY_USER_CREATED, {
      userId: user.id,
      email: user.email,
      role: user.role,
      actor,
    });
    return toUserView(user);
  }

  /**
   * Change an account's role and/or enabled state. The set of active admins can never become empty
   * (checked inside a transaction under the same advisory lock as registration), so no sequence of
   * requests can lock everyone out. Disabling also revokes the account's tokens (tokenVersion + 1).
   */
  async updateUser(
    id: string,
    change: { role?: Role; disabled?: boolean },
    actor: string | null,
  ): Promise<UserView> {
    const updated = await this.users.manager.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock($1)", [BOOTSTRAP_LOCK_KEY]);
      const all = await tx.find(User);
      const user = all.find((u) => u.id === id);
      if (!user) {
        throw new NotFoundException(`User ${id} not found`);
      }
      const isActiveAdmin = user.role === "admin" && !user.disabledAt;
      const nextRole = change.role ?? user.role;
      const nextDisabled = change.disabled ?? Boolean(user.disabledAt);
      const staysActiveAdmin = nextRole === "admin" && !nextDisabled;
      if (isActiveAdmin && !staysActiveAdmin) {
        const activeAdmins = all.filter((u) => u.role === "admin" && !u.disabledAt).length;
        if (activeAdmins <= 1) {
          throw new ConflictException("Cannot demote or disable the last active admin");
        }
      }

      const changes: UserUpdatedPayload["changes"] = {};
      if (change.role !== undefined && change.role !== user.role) {
        changes.role = { from: user.role, to: change.role };
        user.role = change.role;
      }
      if (change.disabled !== undefined && change.disabled !== Boolean(user.disabledAt)) {
        changes.disabled = change.disabled;
        user.disabledAt = change.disabled ? new Date() : null;
        if (change.disabled) {
          user.tokenVersion += 1; // revoke every token issued so far
        }
      }
      if (Object.keys(changes).length > 0) {
        await tx.save(user);
      }
      return { user, changes };
    });

    this.stateCache.delete(id);
    if (Object.keys(updated.changes).length > 0) {
      this.publish<UserUpdatedPayload>(EventTypes.SECURITY_USER_UPDATED, {
        userId: id,
        email: updated.user.email,
        changes: updated.changes,
        actor,
      });
    }
    return toUserView(updated.user);
  }

  /** Admin reset. Revokes the account's existing tokens. */
  async resetPassword(id: string, newPassword: string, actor: string | null): Promise<void> {
    const user = await this.users.findOne({ where: { id } });
    if (!user) {
      throw new NotFoundException(`User ${id} not found`);
    }
    await this.applyPassword(user, newPassword, "admin", actor);
  }

  /** Self-service change. Returns a fresh token — the old one is revoked by the version bump. */
  async changeOwnPassword(id: string, current: string, next: string): Promise<AuthResult> {
    const user = await this.users.findOne({ where: { id } });
    if (!user || user.disabledAt || !(await compare(current, user.passwordHash))) {
      throw new ForbiddenException("Current password is incorrect");
    }
    await this.applyPassword(user, next, "self", id);
    return this.issueToken(user);
  }

  private async applyPassword(user: User, newPassword: string, by: "self" | "admin", actor: string | null): Promise<void> {
    user.passwordHash = await hash(newPassword, BCRYPT_ROUNDS);
    user.tokenVersion += 1;
    await this.users.save(user);
    this.stateCache.delete(user.id);
    this.publish<PasswordChangedPayload>(EventTypes.SECURITY_PASSWORD_CHANGED, {
      userId: user.id,
      email: user.email,
      by,
      actor,
    });
  }

  private assertBootstrapToken(presented: string | undefined): void {
    if (!this.bootstrapToken) {
      return;
    }
    const expected = createHash("sha256").update(this.bootstrapToken, "utf8").digest();
    const actual = createHash("sha256").update(presented ?? "", "utf8").digest();
    if (!presented || !timingSafeEqual(expected, actual)) {
      throw new ForbiddenException("A valid bootstrap token is required to create the first admin");
    }
  }

  private async issueToken(user: User): Promise<AuthResult> {
    const payload: JwtPayload = { sub: user.id, email: user.email, role: user.role, tv: user.tokenVersion ?? 0 };
    return {
      accessToken: await this.jwt.signAsync(payload),
      user: { id: user.id, email: user.email, role: user.role },
    };
  }

  private publish<P>(type: string, payload: P): void {
    this.bus?.publish(createEvent<P>({ type, source: "module:identity", payload }));
  }
}
