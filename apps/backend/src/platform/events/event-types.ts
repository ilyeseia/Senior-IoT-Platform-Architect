/**
 * Catalog of event types and their payloads (ADVANCED-ARCHITECTURE-AUDIT.md §20). This file is the
 * contract between modules: a producer and its consumers share these types and nothing else.
 *
 * Naming: `<subject>.<verb>` in the past tense, dotted, lower case. Adding a field is compatible;
 * changing or removing one requires a new `schema_version`.
 */
export const EventTypes = {
  /** Gateway → registry: a raw presence observation (birth/LWT message). Internal; not audited. */
  DEVICE_PRESENCE_REPORTED: "device.presence.reported",
  /** Registry: a device id was seen for the first time. */
  DEVICE_REGISTERED: "device.registered",
  /** Registry: presence changed from offline to online. */
  DEVICE_ONLINE: "device.online",
  /** Registry: presence changed from online to offline. */
  DEVICE_OFFLINE: "device.offline",
  /** Commands: a command was persisted and is about to be sent. */
  DEVICE_COMMAND_CREATED: "device.command.created",
  /** Commands: a command reached a terminal status (succeeded/failed/rejected/timed_out). */
  DEVICE_COMMAND_COMPLETED: "device.command.completed",
  /** Telemetry: a poll stored new samples. High volume; not audited. */
  DEVICE_TELEMETRY_UPDATED: "device.telemetry.updated",
  /** Twin: an operator changed a device's desired state. */
  DEVICE_STATE_CHANGED: "device.state.changed",
} as const;

export type EventType = (typeof EventTypes)[keyof typeof EventTypes];

export interface PresenceReportedPayload {
  baseTopic: string;
  online: boolean;
}

export interface DeviceRegisteredPayload {
  baseTopic: string;
}

export interface DeviceOnlinePayload {
  previous: boolean;
}

export type DeviceOfflinePayload = DeviceOnlinePayload;

export interface CommandCreatedPayload {
  commandId: string;
  name: string;
  timeoutMs: number;
}

export interface CommandCompletedPayload {
  commandId: string;
  name: string;
  /** Terminal status only (never "pending"). */
  status: "succeeded" | "failed" | "rejected" | "timed_out";
  ok: boolean;
  durationMs: number;
}

export interface TelemetrySamplePayload {
  metric: string;
  /** A number or boolean — the only value types telemetry stores. */
  value: number | boolean;
}

export interface TelemetryUpdatedPayload {
  /** The capability the samples were extracted from, e.g. "mqtt_status". */
  source: string;
  count: number;
  samples: TelemetrySamplePayload[];
}

export interface StateChangedPayload {
  changed: Record<string, unknown>;
  desiredVersion: number;
  drift: string[];
}

/**
 * Event types worth keeping in the append-only audit history (audit §22: device lifecycle,
 * commands, OTA, security, configuration, important state changes). High-volume signals
 * (telemetry, raw presence observations) are deliberately excluded.
 */
export function isAuditedEventType(type: string): boolean {
  return (
    type === EventTypes.DEVICE_REGISTERED ||
    type === EventTypes.DEVICE_ONLINE ||
    type === EventTypes.DEVICE_OFFLINE ||
    type === EventTypes.DEVICE_COMMAND_CREATED ||
    type === EventTypes.DEVICE_COMMAND_COMPLETED ||
    type === EventTypes.DEVICE_STATE_CHANGED ||
    type.startsWith("device.ota.") ||
    type.startsWith("device.alert.") ||
    type.startsWith("agent.") ||
    type.startsWith("security.")
  );
}
