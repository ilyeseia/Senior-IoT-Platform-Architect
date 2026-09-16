/**
 * ESP-Claw local capability catalog — the exact shape of the firmware's
 * `GET /api/capabilities` response, verified against the real esp-claw-2
 * firmware this session (http_server_capabilities_api.c):
 *
 *   {
 *     "items": [
 *       { "group_id": "cap_mqtt", "display_name": "MQTT", "default_llm_visible": true },
 *       { "group_id": "cap_vpn",  "display_name": "VPN",  "default_llm_visible": true },
 *       ...
 *     ]
 *   }
 *
 * IMPORTANT (grounding, per brief rule #38 and PHASE1-ANALYSIS.md §K):
 * this endpoint lists capability *groups* only — group_id, a display name, and
 * whether the group is LLM-visible by default. It does NOT return the per-tool
 * descriptors (id/family/kind/cap_flags/JSON-Schema) that live inside
 * `claw_cap_descriptor_t` on-device; those are not exposed over HTTP today, so
 * we deliberately do not model them. Individual tools are invoked over MQTT via
 * the command envelope (`action: "capability", name: "<tool>"`), not discovered
 * from this endpoint.
 *
 * This is a device-local, LAN-only, unauthenticated surface. The client that
 * reads it (apps/backend `LocalApiClient`) must only ever read `/api/status` and
 * `/api/capabilities` — never mirror `/api/config`, which returns secrets in
 * plaintext (PHASE1-ANALYSIS.md §K).
 */
import { z } from "zod";

export const CapabilityGroupSchema = z.object({
  group_id: z.string().min(1),
  display_name: z.string().default(""),
  default_llm_visible: z.boolean().default(false),
});
export type CapabilityGroup = z.infer<typeof CapabilityGroupSchema>;

export const CapabilityCatalogSchema = z.object({
  items: z.array(CapabilityGroupSchema).default([]),
});
export type CapabilityCatalog = z.infer<typeof CapabilityCatalogSchema>;

export function parseCapabilityCatalog(raw: unknown): CapabilityCatalog {
  return CapabilityCatalogSchema.parse(raw);
}

/** Sorted, de-duplicated list of group ids — a stable summary of what a device can do. */
export function capabilityGroupIds(catalog: CapabilityCatalog): string[] {
  return [...new Set(catalog.items.map((g) => g.group_id))].sort();
}

/**
 * Real device `GET /api/status` shape (subset we rely on), verified against the
 * firmware (http_server_status_api.c): Wi-Fi/AP presence + IP + mode. Fields are
 * optional/loose because it is a debug surface and may grow.
 */
export const LocalStatusSchema = z
  .object({
    wifi_connected: z.boolean().optional(),
    ip: z.string().optional(),
    ap_active: z.boolean().optional(),
    ap_ssid: z.string().optional(),
    ap_ip: z.string().optional(),
    wifi_mode: z.string().optional(),
    storage_base_path: z.string().optional(),
  })
  .passthrough();
export type LocalStatus = z.infer<typeof LocalStatusSchema>;

export function parseLocalStatus(raw: unknown): LocalStatus {
  return LocalStatusSchema.parse(raw);
}
