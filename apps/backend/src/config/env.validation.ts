/**
 * Env validation, updated as each phase lands (see the doc-comment on each
 * field below for exactly why it is or isn't required yet):
 *  - Phase 3: PORT/NODE_ENV required to boot.
 *  - Phase 4: MQTT_URL stays OPTIONAL on purpose — it's a real, external,
 *    user-owned broker credential (CloudAMQP) that this codebase never
 *    holds; requiring it would block anyone from running/testing the rest
 *    of the app without real credentials. MqttService degrades gracefully.
 *  - Phase 5: DATABASE_URL is now REQUIRED — unlike MQTT, a local dev
 *    Postgres is something anyone can stand up themselves with
 *    `docker compose up -d postgres` using the fixed dev-only credentials in
 *    .env.example, so there's no reason to degrade gracefully here.
 *  - REDIS_URL / JWT_SECRET remain optional until Phase 8 / Phase 10.
 *  - TELEMETRY_POLL_INTERVAL_MS (Architecture Evolution §13, Option B):
 *    optional, defaults to 60000ms in TelemetryPollerService itself — not
 *    required to boot, same reasoning as MQTT_URL: a sensible built-in
 *    default exists, so nobody is blocked from running the app without
 *    tuning this first.
 */
import { z } from "zod";

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),

  MQTT_URL: z.string().url().optional(),
  MQTT_BASE_TOPIC_PREFIX: z.string().min(1).default("espclaw"),

  DATABASE_URL: z.string().url(),

  REDIS_URL: z.string().url().optional(),
  JWT_SECRET: z.string().min(1).optional(),

  TELEMETRY_POLL_INTERVAL_MS: z.coerce.number().int().positive().optional(),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(config);
  if (!parsed.success) {
    throw new Error(`Invalid environment configuration:\n${parsed.error.toString()}`);
  }
  return parsed.data;
}
