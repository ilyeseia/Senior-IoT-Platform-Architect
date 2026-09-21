import { Module } from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { MqttModule } from "../mqtt";
import { HttpMetricsInterceptor } from "./http-metrics.interceptor";
import { MetricsController } from "./metrics.controller";
import { MetricsService } from "./metrics.service";

/** Metrics and (with json-logger.ts) structured logging. Observes the platform; nothing depends on it. */
@Module({
  imports: [MqttModule],
  controllers: [MetricsController],
  providers: [MetricsService, { provide: APP_INTERCEPTOR, useClass: HttpMetricsInterceptor }],
})
export class ObservabilityModule {}
