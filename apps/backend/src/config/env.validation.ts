/**
 * Env validation for Phase 3 (Backend skeleton). Only PORT/NODE_ENV are
 * actually required to boot right now. MQTT_URL/DATABASE_URL/REDIS_URL/
 * JWT_SECRET are validated for *shape* (so a typo'd .env fails fast once
 * they're introduced) but are optional at this phase — nothing in Phase 3
 * connects to them yet. Phase 4 (MQTT), Phase 5 (Database) and Phase 10
 * (Security) each promote their own variable to required as that
 * integration actually lands, instead of the whole app refusing to boot
 * before those phases exist.
 */
import { z } from "zod";

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),

  MQTT_URL: z.string().url().optional(),
  MQTT_BASE_TOPIC_PREFIX: z.string().min(1).default("espclaw"),

  DATABASE_URL: z.string().url().optional(),
  REDIS_URL: z.string().url().optional(),
  JWT_SECRET: z.string().min(1).optional(),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(config);
  if (!parsed.success) {
    throw new Error(`Invalid environment configuration:\n${parsed.error.toString()}`);
  }
  return parsed.data;
}
