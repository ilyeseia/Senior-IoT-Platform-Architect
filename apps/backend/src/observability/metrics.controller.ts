import { Controller, Get, Header } from "@nestjs/common";
import { RequirePermission } from "../platform";
import { MetricsService } from "./metrics.service";

/**
 * Prometheus scrape endpoint. Deliberately NOT @Public(): it goes through the normal JWT guard
 * (Prometheus can send a bearer token), because metrics reveal device ids' volume, routes and
 * internals. Unversioned by design — scrapers should not chase an API version.
 */
@Controller("metrics")
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  // Nest sends a returned string as text/html; scrapers expect the Prometheus text exposition format.
  @RequirePermission("metrics:read")
  @Get()
  @Header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
  @Header("Cache-Control", "no-store")
  async scrape(): Promise<string> {
    return this.metrics.render();
  }
}
