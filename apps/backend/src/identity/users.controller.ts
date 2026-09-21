import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Req } from "@nestjs/common";
import { z } from "zod";
import { AnyAuthenticated, RequirePermission, ROLES, permissionsFor } from "../platform";
import { parseBody } from "../common/validation/parse-body";
import { IdentityService } from "./identity.service";
import type { JwtPayload } from "./identity.service";

const roleSchema = z.enum(ROLES);
const passwordSchema = z.string().min(8).max(128);

const createUserSchema = z
  .object({ email: z.string().email().max(255), password: passwordSchema, role: roleSchema })
  .strict();

const updateUserSchema = z
  .object({ role: roleSchema.optional(), disabled: z.boolean().optional() })
  .strict()
  .refine((v) => v.role !== undefined || v.disabled !== undefined, { message: "Provide role and/or disabled" });

const resetPasswordSchema = z.object({ password: passwordSchema }).strict();
const changePasswordSchema = z.object({ currentPassword: z.string().min(1).max(128), newPassword: passwordSchema }).strict();

interface AuthedRequest {
  user: JwtPayload;
}

/** Account administration (admin only) and the caller's own account. */
@Controller()
export class UsersController {
  constructor(private readonly identity: IdentityService) {}

  @Get("auth/me")
  @AnyAuthenticated()
  me(@Req() req: AuthedRequest) {
    return {
      id: req.user.sub,
      email: req.user.email,
      role: req.user.role, // the live role (PermissionsGuard replaced the token's)
      permissions: permissionsFor(req.user.role),
    };
  }

  @Post("auth/password")
  @AnyAuthenticated()
  changeOwnPassword(@Body() body: unknown, @Req() req: AuthedRequest) {
    const { currentPassword, newPassword } = parseBody(changePasswordSchema, body);
    return this.identity.changeOwnPassword(req.user.sub, currentPassword, newPassword);
  }

  @Get("users")
  @RequirePermission("users:manage")
  list() {
    return this.identity.listUsers();
  }

  @Post("users")
  @RequirePermission("users:manage")
  create(@Body() body: unknown, @Req() req: AuthedRequest) {
    const { email, password, role } = parseBody(createUserSchema, body);
    return this.identity.createUser(email, password, role, req.user.sub);
  }

  @Patch("users/:id")
  @RequirePermission("users:manage")
  update(@Param("id", ParseUUIDPipe) id: string, @Body() body: unknown, @Req() req: AuthedRequest) {
    return this.identity.updateUser(id, parseBody(updateUserSchema, body), req.user.sub);
  }

  @Post("users/:id/password")
  @RequirePermission("users:manage")
  async resetPassword(@Param("id", ParseUUIDPipe) id: string, @Body() body: unknown, @Req() req: AuthedRequest) {
    const { password } = parseBody(resetPasswordSchema, body);
    await this.identity.resetPassword(id, password, req.user.sub);
    return { ok: true };
  }
}
