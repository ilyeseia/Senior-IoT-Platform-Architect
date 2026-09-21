import { SetMetadata } from "@nestjs/common";
import type { Permission } from "./permissions";

export const IS_PUBLIC_KEY = "isPublic";
export const PERMISSION_KEY = "requiredPermission";
export const ANY_AUTHENTICATED_KEY = "anyAuthenticated";

/** No authentication at all (liveness probes, login). Use sparingly. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** Requires a valid session whose user currently holds `permission`. */
export const RequirePermission = (permission: Permission) => SetMetadata(PERMISSION_KEY, permission);

/**
 * Requires a valid session but no particular permission — for "my own account" routes
 * (who am I, change my password). Every non-public route must carry exactly one of Public,
 * RequirePermission or AnyAuthenticated: a route with none is refused (fail closed), and a
 * test enforces that for every controller.
 */
export const AnyAuthenticated = () => SetMetadata(ANY_AUTHENTICATED_KEY, true);
