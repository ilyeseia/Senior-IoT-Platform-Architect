import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { EventEmitterModule } from "@nestjs/event-emitter";
import { validateEnv } from "./config/env.validation";
import { HealthModule } from "./health/health.module";
import { EspClawModule } from "./esp-claw/esp-claw.module";
import { MqttModule } from "./mqtt/mqtt.module";
import { DatabaseModule } from "./database/database.module";
import { DevicesModule } from "./devices/devices.module";
import { CommandsModule } from "./commands/commands.module";
import { TelemetryModule } from "./telemetry/telemetry.module";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
    }),
    EventEmitterModule.forRoot(),
    DatabaseModule,
    HealthModule,
    EspClawModule,
    MqttModule,
    DevicesModule,
    CommandsModule,
    TelemetryModule,
  ],
})
export class AppModule {}
