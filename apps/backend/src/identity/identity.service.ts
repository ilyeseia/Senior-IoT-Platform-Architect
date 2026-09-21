import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Optional,
  UnauthorizedException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { JwtService } from "@nestjs/jwt";
import { compare, hash } from "bcryptjs";
import { createHash, timingSafeEqual } from "crypto";
import { Repository } from "typeorm";
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
/** Arbitrary constant used as the Postgres advisory-lock key that serialises first-admin registration. */
const BOOTSTRAP_LOCK_KEY = 7_301_001;

/** DI token for the optional first-admin bootstrap secret (ADMIN_BOOTSTRAP_TOKEN). */
export const ADMIN_BOOTSTRAP_TOKEN = "ADMIN_BOOTSTRAP_TOKEN";

export interface JwtPayload {
  sub: string;
  email: string;
  role: string;
}

export interface AuthResult {
  accessToken: string;
  user: { id: string; email: string; role: string };
}

@Injectable()
export class IdentityService {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly jwt: JwtService,
    @Optional() @Inject(ADMIN_BOOTSTRAP_TOKEN) private readonly bootstrapToken?: string,
    @Optional() private readonly throttle: LoginThrottle = new LoginThrottle(),
  ) {}

  /**
   * First-admin bootstrap (Architecture Evolution §22): there's no signup
   * flow, and no operator UI to seed a user from yet — so registration is
   * only allowed while the `users` table is empty. Once one user exists,
   * this always rejects; creating further users is an admin-only action for
   * a later phase (Device Groups/Policies), not open self-registration.
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
    return this.issueToken(user);
  }

  async login(email: string, password: string, clientAddress = "unknown"): Promise<AuthResult> {
    this.throttle.assertAllowed(email, clientAddress);

    const user = await this.users.findOne({ where: { email } });
    // Always run one bcrypt comparison — with a dummy hash when the account does not exist — so
    // response time does not reveal which emails are registered.
    const valid = await compare(password, user?.passwordHash ?? (await getDummyHash()));
    if (!user || !valid) {
      this.throttle.recordFailure(email, clientAddress);
      throw new UnauthorizedException("Invalid email or password");
    }
    this.throttle.recordSuccess(email);
    return this.issueToken(user);
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
    const payload: JwtPayload = { sub: user.id, email: user.email, role: user.role };
    return {
      accessToken: await this.jwt.signAsync(payload),
      user: { id: user.id, email: user.email, role: user.role },
    };
  }
}
