import { z } from "zod";

/**
 * `.strict()` on purpose: `baseTopic` used to be accepted here, which let a
 * caller address any topic prefix (audit B4). The topic prefix now always
 * comes from the device's registry row; a client still sending it gets a 400
 * instead of a silently ignored field.
 */
export const dispatchCommandSchema = z
  .object({
    name: z.string().min(1).max(255),
    input: z.record(z.unknown()).optional(),
    timeoutMs: z.number().int().min(1000).max(60_000).optional(),
  })
  .strict();

export type DispatchCommandDto = z.infer<typeof dispatchCommandSchema>;
