import { Module } from "@nestjs/common";
import { EspClawModule } from "../esp-claw";
import { MqttService } from "./mqtt.service";

/**
 * No controller on purpose: the former debug endpoints (`/mqtt/*`) let any
 * caller publish commands to any device/baseTopic without a DB record or an
 * audit trail (audit finding B4). All operator-facing command traffic goes
 * through CommandsModule, which persists every dispatch.
 */
@Module({
  imports: [EspClawModule],
  providers: [MqttService],
  exports: [MqttService],
})
export class MqttModule {}
