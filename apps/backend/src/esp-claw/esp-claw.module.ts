import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { EspClawController } from "./esp-claw.controller";
import { TopicService } from "./topic.service";
import { LOCAL_API_ALLOWED_HOSTS, LocalApiClient } from "./local-api-client";
import { parseAllowedHosts } from "./local-target";
import type { Env } from "../config/env.validation";

@Module({
  controllers: [EspClawController],
  providers: [
    TopicService,
    {
      provide: LOCAL_API_ALLOWED_HOSTS,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        parseAllowedHosts(config.get("LOCAL_API_ALLOWED_HOSTS", { infer: true })),
    },
    LocalApiClient,
  ],
  exports: [TopicService, LocalApiClient],
})
export class EspClawModule {}
