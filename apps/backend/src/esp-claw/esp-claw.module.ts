import { Module } from "@nestjs/common";
import { EspClawController } from "./esp-claw.controller";
import { TopicService } from "./topic.service";
import { LocalApiClient } from "./local-api-client";

@Module({
  controllers: [EspClawController],
  providers: [TopicService, LocalApiClient],
  exports: [TopicService, LocalApiClient],
})
export class EspClawModule {}
