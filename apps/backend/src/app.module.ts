import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
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
import { ObservabilityModule } from "./observability";
import { ApiExceptionFilter, ApiVersionMiddleware, CorrelationMiddleware, EventsModule } from "./platform";

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
    ObservabilityModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: ApiExceptionFilter }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Every request gets a correlation id (and trace ids from `traceparent`) before any handler runs.
    consumer.apply(CorrelationMiddleware, ApiVersionMiddleware).forRoutes("*");
  }
}
