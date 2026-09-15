import { Module } from "@nestjs/common";
import { EspClawController } from "./esp-claw.controller";
import { TopicService } from "./topic.service";

@Module({
  controllers: [EspClawController],
  providers: [TopicService],
  exports: [TopicService],
})
export class EspClawModule {}
