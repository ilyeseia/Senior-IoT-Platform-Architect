import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import { AppModule } from "./app.module";
import type { Env } from "./config/env.validation";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // Without this Nest never runs OnModuleDestroy on SIGTERM/SIGINT (docker stop):
  // the MQTT connection, timers and pending commands would just be cut off.
  app.enableShutdownHooks();
  const config = app.get(ConfigService<Env, true>);
  const port = config.get("PORT", { infer: true });
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`[backend] listening on :${port} (env=${config.get("NODE_ENV", { infer: true })})`);
}

bootstrap();
