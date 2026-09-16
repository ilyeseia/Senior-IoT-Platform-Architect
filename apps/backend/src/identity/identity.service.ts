import { ConflictException, Injectable, UnauthorizedException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { JwtService } from "@nestjs/jwt";
import { compare, hash } from "bcryptjs";
import { Repository } from "typeorm";
import { User } from "./user.entity";

const BCRYPT_ROUNDS = 12;

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
  ) {}

  /**
   * First-admin bootstrap (Architecture Evolution §22): there's no signup
   * flow, and no operator UI to seed a user from yet — so registration is
   * only allowed while the `users` table is empty. Once one user exists,
   * this always rejects; creating further users is an admin-only action for
   * a later phase (Device Groups/Policies), not open self-registration.
   */
  async register(email: string, password: string): Promise<AuthResult> {
    const existingCount = await this.users.count();
    if (existingCount > 0) {
      throw new ConflictException(
        "Registration is closed — an admin user already exists. Ask an existing admin.",
      );
    }
    const passwordHash = await hash(password, BCRYPT_ROUNDS);
    const user = await this.users.save(this.users.create({ email, passwordHash, role: "admin" }));
    return this.issueToken(user);
  }

  async login(email: string, password: string): Promise<AuthResult> {
    const user = await this.users.findOne({ where: { email } });
    if (!user || !(await compare(password, user.passwordHash))) {
      throw new UnauthorizedException("Invalid email or password");
    }
    return this.issueToken(user);
  }

  private async issueToken(user: User): Promise<AuthResult> {
    const payload: JwtPayload = { sub: user.id, email: user.email, role: user.role };
    return {
      accessToken: await this.jwt.signAsync(payload),
      user: { id: user.id, email: user.email, role: user.role },
    };
  }
}
