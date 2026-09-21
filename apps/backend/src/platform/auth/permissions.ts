/**
 * Roles and permissions (ADVANCED-ARCHITECTURE-AUDIT.md §22). A permission is `<area>:<action>`;
 * every route declares the one it needs (see decorators.ts) and a role is just a named set of them.
 * Lives in the kernel so any module can annotate its routes without depending on the identity module.
 *
 * Deliberately small and closed: adding a role or permission is a code change reviewed with the
 * routes it affects, not runtime data. A future policy engine (per-device-group scopes, tool risk
 * classes for AI agents) layers on top of this; it does not replace it.
 */
export const PERMISSIONS = [
  "devices:read",
  "devices:write", // refresh capability catalog, edit device metadata
  "commands:read",
  "commands:dispatch", // send capability commands to devices
  "twin:read",
  "twin:write", // set desired state
  "telemetry:read",
  "audit:read", // the append-only event history
  "metrics:read",
  "users:manage",
  "devices:privileged", // platform_exec: OTA, network/MQTT/VPN configuration, agent inspection
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const ROLES = ["admin", "operator", "viewer"] as const;
export type Role = (typeof ROLES)[number];

const VIEWER: readonly Permission[] = ["devices:read", "commands:read", "twin:read", "telemetry:read"];
const OPERATOR: readonly Permission[] = [...VIEWER, "devices:write", "commands:dispatch", "twin:write"];

/**
 * viewer   — read-only.
 * operator — day-to-day operation: send (non-privileged) commands, set desired state.
 * admin    — everything, including the audit log, metrics, user management and privileged device operations.
 */
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  viewer: VIEWER,
  operator: OPERATOR,
  admin: PERMISSIONS,
};

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

/** Permissions of a role; an unknown role (e.g. a stale value) has none — fail closed. */
export function permissionsFor(role: string): readonly Permission[] {
  return isRole(role) ? ROLE_PERMISSIONS[role] : [];
}

export function roleHasPermission(role: string, permission: Permission): boolean {
  return permissionsFor(role).includes(permission);
}
