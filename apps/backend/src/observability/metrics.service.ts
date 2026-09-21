import { Inject, Injectable, OnModuleInit } from "@nestjs/common";
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";
import { EVENT_BUS, EventTypes, InProcessEventBus } from "../platform";
import type { CommandCompletedPayload, DomainEvent, EventBus, EventBusStats } from "../platform";
import { MqttService } from "../mqtt";

/** Buckets tuned for a request/response system whose slow path is a device round trip over MQTT. */
const HTTP_BUCKETS = [0.005, 0.02, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 20];
const COMMAND_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60];

/**
 * Prometheus metrics (audit §16: API latency, command latency, event/bus health, MQTT state).
 * A private Registry — not prom-client's global one — so tests and multiple app instances in one
 * process never collide on metric names.
 *
 * Domain metrics come from the event bus, so this module observes the platform without any
 * producer knowing it exists: command duration from `device.command.completed`, event volume from
 * every event. Only two live values are read directly: MQTT connectivity and the bus counters.
 */
@Injectable()
export class MetricsService implements OnModuleInit {
  readonly registry = new Registry();

  private readonly httpDuration = new Histogram({
    name: "http_request_duration_seconds",
    help: "HTTP request latency by method, route and status",
    labelNames: ["method", "route", "status"] as const,
    buckets: HTTP_BUCKETS,
    registers: [this.registry],
  });

  private readonly commandDuration = new Histogram({
    name: "esp_claw_command_duration_seconds",
    help: "Command latency from dispatch to a terminal status, by status",
    labelNames: ["status"] as const,
    buckets: COMMAND_BUCKETS,
    registers: [this.registry],
  });

  private readonly eventsTotal = new Counter({
    name: "esp_claw_events_total",
    help: "Domain events observed on the bus, by type",
    labelNames: ["type"] as const,
    registers: [this.registry],
  });

  constructor(
    @Inject(EVENT_BUS) private readonly bus: EventBus,
    private readonly mqtt: MqttService,
    private readonly inProcessBus: InProcessEventBus,
  ) {
    collectDefaultMetrics({ register: this.registry });

    const mqttService = this.mqtt;
    new Gauge({
      name: "esp_claw_mqtt_connected",
      help: "1 when the platform is connected to the MQTT broker, 0 otherwise (also 0 when MQTT is not configured)",
      registers: [this.registry],
      collect() {
        this.set(mqttService.isConnected() ? 1 : 0);
      },
    });

    // The bus keeps plain running totals; expose them as real counters by adding the delta at scrape time.
    const inProcess = this.inProcessBus;
    const busCounters: [string, string, (s: EventBusStats) => number][] = [
      ["esp_claw_event_bus_published_total", "Events published to the in-process bus", (s) => s.published],
      ["esp_claw_event_bus_delivered_total", "Successful handler deliveries", (s) => s.delivered],
      ["esp_claw_event_bus_failed_total", "Handler deliveries that failed after all retries", (s) => s.failed],
      ["esp_claw_event_bus_timeouts_total", "Handler attempts that exceeded their timeout", (s) => s.timedOut],
    ];
    for (const [name, help, pick] of busCounters) {
      let last = 0;
      new Counter({
        name,
        help,
        registers: [this.registry],
        collect() {
          const total = pick(inProcess.stats());
          this.inc(total - last);
          last = total;
        },
      });
    }
  }

  onModuleInit(): void {
    this.bus.subscribe("**", (event) => this.observeEvent(event), { name: "observability.metrics" });
  }

  observeHttp(method: string, route: string, status: number, seconds: number): void {
    this.httpDuration.observe({ method, route, status: String(status) }, seconds);
  }

  observeEvent(event: DomainEvent): void {
    this.eventsTotal.inc({ type: event.event_type });
    if (event.event_type === EventTypes.DEVICE_COMMAND_COMPLETED) {
      const p = event.payload as CommandCompletedPayload;
      this.commandDuration.observe({ status: p.status }, p.durationMs / 1000);
    }
  }

  async render(): Promise<string> {
    return this.registry.metrics();
  }

  get contentType(): string {
    return this.registry.contentType;
  }
}
