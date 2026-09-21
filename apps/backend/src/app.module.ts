import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { validateEnv } from "./config/env.validation";
import { HealthModule } from "./health";
import { EspClawModule } from "./esp-claw";
import { MqttModule } from "./mqtt";
import { DatabaseModule } from "./database";
import { DevicesModule } from "./devices";
import { CommandsModule } from "./commands";
import { TelemetryModule } from "./telemetry";
import { IdentityModule } from "./identity";
import { TwinModule } from "./twin";
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
