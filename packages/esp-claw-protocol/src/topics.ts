/**
 * Real ESP-Claw MQTT topic scheme (verified against firmware this session —
 * see docs/architecture/PHASE1-ANALYSIS.md §0/§C):
 *
 *   {base_topic}/{device_id}/{leaf}
 *
 * `base_topic` is a free-text device config field (`mqtt_base_topic`, default
 * "espclaw") built into the firmware's `mqtt_manager_build_topic()`. It may
 * itself contain "/" — that's how tenant scoping works with zero firmware
 * changes (e.g. "espclaw/acme-farms"). Only THREE leaves exist on real
 * hardware today: status, command, response. Do not add telemetry/events/logs
 * leaves here until the corresponding ESP-Claw capability actually exists
 * (Phase 6) — this file must only describe what the firmware really does.
 */

export const LEAVES = ["status", "command", "response"] as const;
export type Leaf = (typeof LEAVES)[number];

export interface DeviceTopics {
  status: string;
  command: string;
  response: string;
}

export function buildTopic(baseTopic: string, deviceId: string, leaf: Leaf): string {
  if (!baseTopic || !baseTopic.trim()) {
    throw new Error("baseTopic is required");
  }
  if (!deviceId || !deviceId.trim()) {
    throw new Error("deviceId is required");
  }
  return `${trimTrailingSlashes(baseTopic)}/${deviceId}/${leaf}`;
}

export function deviceTopics(baseTopic: string, deviceId: string): DeviceTopics {
  return {
    status: buildTopic(baseTopic, deviceId, "status"),
    command: buildTopic(baseTopic, deviceId, "command"),
    response: buildTopic(baseTopic, deviceId, "response"),
  };
}

export interface ParsedTopic {
  baseTopic: string;
  deviceId: string;
  leaf: string;
}

/**
 * Inverse of buildTopic(). Correctly handles a multi-segment (tenant-scoped)
 * baseTopic by treating the LAST two segments as deviceId/leaf and everything
 * before that as baseTopic — required because baseTopic itself may contain
 * slashes (see module doc above).
 */
export function parseTopic(topic: string): ParsedTopic | null {
  const parts = topic.split("/").filter((p) => p.length > 0);
  if (parts.length < 3) {
    return null;
  }
  const leaf = parts[parts.length - 1];
  const deviceId = parts[parts.length - 2];
  const baseTopic = parts.slice(0, parts.length - 2).join("/");
  if (!baseTopic || !deviceId || !leaf) {
    return null;
  }
  return { baseTopic, deviceId, leaf };
}

/**
 * MQTT subscription filter for one leaf, ONLY valid when every device's
 * baseTopic is a single segment (no tenant scoping, e.g. "espclaw"). A "+"
 * wildcard matches exactly one topic level, so this breaks the moment any
 * device uses a multi-segment baseTopic like "espclaw/acme-farms" (see module
 * doc). Once tenant scoping is in use, subscribe broadly (e.g. "#") and
 * filter/route with parseTopic() in application code instead — that's
 * correct regardless of how many segments a given deployment's baseTopic has.
 */
export function singleSegmentWildcardFilterForLeaf(leaf: Leaf): string {
  return `+/+/${leaf}`;
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}
