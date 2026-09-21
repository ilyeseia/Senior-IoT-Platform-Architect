import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { validateEnv } from "./config/env.validation";
import { HealthModule } from "./health/health.module";
import { EspClawModule } from "./esp-claw/esp-claw.module";
import { MqttModule } from "./mqtt/mqtt.module";
import { DatabaseModule } from "./database/database.module";
import { DevicesModule } from "./devices/devices.module";
import { CommandsModule } from "./commands/commands.module";
import { TelemetryModule } from "./telemetry/telemetry.module";
import { IdentityModule } from "./identity/identity.module";
import { TwinModule } from "./twin/twin.module";
import { AuditModule } from "./audit";
import { CorrelationMiddleware, EventsModule } from "./platform";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
    }),
    EventsModule,
    DatabaseModule,
    IdentityModule,
    HealthModule,
    EspClawModule,
    MqttModule,
    DevicesModule,
    CommandsModule,
    TwinModule,
    TelemetryModule,
    AuditModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Every request gets a correlation id (and trace ids from `traceparent`) before any handler runs.
    consumer.apply(CorrelationMiddleware).forRoutes("*");
  }
}
