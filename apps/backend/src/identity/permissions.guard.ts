import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import {
  ANY_AUTHENTICATED_KEY,
  IS_PUBLIC_KEY,
  PERMISSION_KEY,
  roleHasPermission,
} from "../platform";
import type { Permission } from "../platform";
import { IdentityService } from "./identity.service";
import type { JwtPayload } from "./identity.service";

interface RequestWithAuth {
  user?: JwtPayload;
}

/**
 * Authorization, run after JwtAuthGuard has verified the token's signature (both are global guards,
 * registered in that order in identity.module.ts).
 *
 *  1. The account is loaded as it is NOW: a deleted or disabled user, or a token whose `tv` is older
 *     than the account's tokenVersion (password changed/reset, account disabled), is refused with 401.
 *  2. The role used for the decision is the account's CURRENT role, not the one baked into the token,
 *     so a demotion takes effect at once (within USER_STATE_TTL_MS).
 *  3. Every non-public route must declare what it needs. A route with neither @RequirePermission nor
 *     @AnyAuthenticated is refused (fail closed) — a forgotten annotation cannot open a route.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly identity: IdentityService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) {
      return true;
    }

    const request = context.switchToHttp().getRequest<RequestWithAuth>();
    const claims = request.user;
    if (!claims) {
      throw new UnauthorizedException("Not authenticated");
    }

    const account = await this.identity.getActiveUser(claims.sub);
    if (!account) {
      throw new UnauthorizedException("Account is disabled or no longer exists");
    }
    if ((claims.tv ?? 0) !== (account.tokenVersion ?? 0)) {
      throw new UnauthorizedException("Session was revoked; sign in again");
    }
    // From here on the request carries the live role, so handlers and audit events see the truth.
    request.user = { ...claims, role: account.role };

    if (this.reflector.getAllAndOverride<boolean>(ANY_AUTHENTICATED_KEY, targets)) {
      return true;
    }
    const required = this.reflector.getAllAndOverride<Permission | undefined>(PERMISSION_KEY, targets);
    if (!required) {
      throw new ForbiddenException("This route has no permission declared");
    }
    if (!roleHasPermission(account.role, required)) {
      throw new ForbiddenException(`Requires the ${required} permission`);
    }
    return true;
  }
}
