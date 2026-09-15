/**
 * Command/response/status envelope shapes — matching what was verified LIVE
 * against a real device and a real broker this session (see
 * PHASE1-ANALYSIS.md §C). Only the "capability" command variant is modeled
 * here (the MVP path: any CLAW_CAP_FLAG_CALLABLE_BY_LLM capability, e.g.
 * get_system_info / mqtt_status / web_search / vpn_status). The firmware's
 * free-text variant (routes into the full agent/LLM pipeline) is documented
 * but deliberately NOT modeled yet — it's unsuitable for reliable platform
 * orchestration (see PHASE1-ANALYSIS.md §B: the LLM can produce a non-tool-call
 * reply instead of acting, observed live this session) and isn't needed until
 * a chat-style admin feature is actually designed.
 *
 * `issued_at` / `timeout_ms` are platform-side additions the real firmware
 * simply ignores today (additive, non-breaking) — used for the Command
 * Service's own timeout bookkeeping (Phase 4).
 */
import { z } from "zod";

export const CommandEnvelopeSchema = z.object({
  id: z.string().min(1),
  action: z.literal("capability"),
  name: z.string().min(1),
  input: z.record(z.unknown()).default({}),
  issued_at: z.string().datetime().optional(),
  timeout_ms: z.number().int().positive().optional(),
});
export type CommandEnvelope = z.infer<typeof CommandEnvelopeSchema>;

/**
 * Real response shape emitted by cap_mqtt on the device, verified live:
 *   {"id":"...", "capability":"...", "ok":true, "result":"..."}
 * and, for a denied restricted/root-agent-only capability:
 *   {"id":"...", "capability":"...", "ok":false,
 *    "result":"Denied agent cap call ... reason=root_agent_only"}
 */
export const ResponseEnvelopeSchema = z.object({
  id: z.string().min(1),
  capability: z.string().optional(),
  ok: z.boolean(),
  result: z.string().optional(),
});
export type ResponseEnvelope = z.infer<typeof ResponseEnvelopeSchema>;

/**
 * Real retained/LWT payload on the `status` leaf, verified live:
 *   birth:  {"online":true}   (qos=1, retain=true, on connect)
 *   LWT:    {"online":false}  (qos=1, retain=true, set at connect time)
 */
export const StatusEnvelopeSchema = z.object({
  online: z.boolean(),
});
export type StatusEnvelope = z.infer<typeof StatusEnvelopeSchema>;

export function parseCommandEnvelope(raw: unknown): CommandEnvelope {
  return CommandEnvelopeSchema.parse(raw);
}

export function parseResponseEnvelope(raw: unknown): ResponseEnvelope {
  return ResponseEnvelopeSchema.parse(raw);
}

export function parseStatusEnvelope(raw: unknown): StatusEnvelope {
  return StatusEnvelopeSchema.parse(raw);
}
