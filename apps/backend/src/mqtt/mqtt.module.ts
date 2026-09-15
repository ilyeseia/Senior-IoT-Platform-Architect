import { Module } from "@nestjs/common";
import { EspClawModule } from "../esp-claw/esp-claw.module";
import { MqttController } from "./mqtt.controller";
import { MqttService } from "./mqtt.service";

@Module({
  imports: [EspClawModule],
  controllers: [MqttController],
  providers: [MqttService],
  exports: [MqttService],
})
export class MqttModule {}
