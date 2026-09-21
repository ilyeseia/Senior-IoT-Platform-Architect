import "reflect-metadata";
import { VERSION_NEUTRAL, VersioningType } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import { AppModule } from "./app.module";
import { JsonLogger } from "./observability";
import type { Env } from "./config/env.validation";

/** Read before the app (and its validated config) exists, only to choose the logger. */
function wantsJsonLogs(): boolean {
  const format = process.env.LOG_FORMAT;
  return format ? format === "json" : process.env.NODE_ENV === "production";
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule, wantsJsonLogs() ? { logger: new JsonLogger() } : {});
  // Without this Nest never runs OnModuleDestroy on SIGTERM/SIGINT (docker stop):
  // the MQTT connection, timers and pending commands would just be cut off.
  app.enableShutdownHooks();
  // URI versioning: every route answers under /v1/... AND, for now, without the prefix
  // (VERSION_NEUTRAL) so existing callers keep working; unversioned responses are marked
  // `Deprecation: true` (see ApiVersionMiddleware). Dropping VERSION_NEUTRAL retires the old paths.
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: [VERSION_NEUTRAL, "1"] });
  const config = app.get(ConfigService<Env, true>);
  const port = config.get("PORT", { infer: true });
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`[backend] listening on :${port} (env=${config.get("NODE_ENV", { infer: true })})`);
}

bootstrap();
