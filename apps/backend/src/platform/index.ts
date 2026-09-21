/**
 * Public API of the platform kernel: the small set of cross-cutting contracts every module may
 * depend on (event envelope + bus port, request context). Modules import from "../platform"; they
 * never reach into its subfolders, and it never imports from a feature module.
 */
export { createEvent } from "./events/domain-event";
export type { DomainEvent, CreateEventInput } from "./events/domain-event";
export { EVENT_BUS } from "./events/event-bus";
export type { EventBus, EventHandler, SubscribeOptions } from "./events/event-bus";
export { EventTypes, isAuditedEventType } from "./events/event-types";
export type {
  EventType,
  PresenceReportedPayload,
  DeviceRegisteredPayload,
  DeviceOnlinePayload,
  DeviceOfflinePayload,
  CommandCreatedPayload,
  CommandCompletedPayload,
  UserCreatedPayload,
  UserUpdatedPayload,
  PasswordChangedPayload,
  LoginSucceededPayload,
  LoginLockedPayload,
  PrivilegedExecutedPayload,
  TelemetrySamplePayload,
  TelemetryUpdatedPayload,
  StateChangedPayload,
} from "./events/event-types";
export { currentContext, runWithContext, contextFromHeaders } from "./context/request-context";
export type { RequestContext } from "./context/request-context";
export { EventsModule } from "./events/events.module";
export { InProcessEventBus, matchesPattern } from "./events/in-process-event-bus";
export type { EventBusStats } from "./events/in-process-event-bus";
export { CorrelationMiddleware } from "./context/correlation.middleware";
export { ApiExceptionFilter, errorCodeForStatus, normalizeException } from "./http/api-exception.filter";
export type { ApiErrorBody } from "./http/api-exception.filter";
export { ApiVersionMiddleware } from "./http/api-version.middleware";
export { PERMISSIONS, ROLES, ROLE_PERMISSIONS, isRole, permissionsFor, roleHasPermission } from "./auth/permissions";
export type { Permission, Role } from "./auth/permissions";
export { Public, RequirePermission, AnyAuthenticated, IS_PUBLIC_KEY, PERMISSION_KEY, ANY_AUTHENTICATED_KEY } from "./auth/decorators";
