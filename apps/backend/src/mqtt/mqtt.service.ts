import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { EventEmitter2 } from "@nestjs/event-emitter";
import mqtt, { MqttClient } from "mqtt";
import { randomUUID } from "crypto";
import { CommandEnvelope, parseResponseEnvelope, parseStatusEnvelope, ResponseEnvelope } from "@esp-claw/protocol";
import { TopicService } from "../esp-claw/topic.service";
import { DEVICE_STATUS_EVENT, DeviceStatusEvent } from "./mqtt.events";
import type { Env } from "../config/env.validation";

export interface DevicePresence {
  deviceId: string;
  online: boolean;
  lastSeenAt: string;
}

interface PendingCommand {
  resolve: (res: ResponseEnvelope) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

const DEFAULT_COMMAND_TIMEOUT_MS = 15000;

/**
 * Single shared connection to the device broker (decision #1: no self-hosted
 * EMQX — this connects to whatever CloudAMQP/other broker MQTT_URL points
 * at). This is the ONLY place in the backend that touches the `mqtt` client
 * library directly; everything else (future Command Service, Device
 * Registry, ...) goes through this service's methods.
 *
 * Correlation is a plain in-memory Map, which is correct and sufficient for
 * a single backend instance. Once the backend is horizontally scaled behind
 * multiple replicas, this needs to move to Redis (tracked for Phase 8) —
 * deliberately not built now, per the "don't build ahead of the phase that
 * needs it" rule established in Phase 3.
 *
 * KNOWN RISK to verify against your actual CloudAMQP plan (not assumed
 * solved): RabbitMQ's MQTT plugin's retained-message support has varied by
 * version/plan. The device's presence mechanism (PHASE1-ANALYSIS.md §C)
 * depends on retained `status` messages being delivered immediately on
 * subscribe. If your CloudAMQP instance doesn't honor that, `listPresence()`
 * will only reflect state *changes* seen after this service subscribes, not
 * a device's already-current state — verify this explicitly, don't assume it.
 */
@Injectable()
export class MqttService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MqttService.name);
  private client: MqttClient | null = null;
  private readonly presence = new Map<string, DevicePresence>();
  private readonly pending = new Map<string, PendingCommand>();
  private readonly mqttUrl: string | undefined;

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly topics: TopicService,
    private readonly events: EventEmitter2,
  ) {
    this.mqttUrl = this.config.get("MQTT_URL", { infer: true });
  }

  onModuleInit(): void {
    if (!this.mqttUrl) {
      this.logger.warn(
        "MQTT_URL not set — MQTT integration is inactive. Set it in .env to connect (see .env.example).",
      );
      return;
    }

    this.client = mqtt.connect(this.mqttUrl, {
      clientId: `esp-claw-platform-${randomUUID().slice(0, 8)}`,
      reconnectPeriod: 2000,
    });

    this.client.on("connect", () => {
      this.logger.log("Connected to MQTT broker");
      // Broad subscription, filtered by parsing the topic ourselves — correct
      // regardless of how many segments a tenant's base_topic has (a fixed-
      // depth wildcard like "+/+/status" breaks for tenant-scoped topics; see
      // packages/esp-claw-protocol/src/topics.ts).
      this.client?.subscribe("#", { qos: 1 }, (err) => {
        if (err) {
          this.logger.error(`Subscribe failed: ${err.message}`);
        }
      });
    });

    this.client.on("reconnect", () => this.logger.warn("Reconnecting to MQTT broker..."));
    this.client.on("close", () => this.logger.warn("MQTT connection closed"));
    this.client.on("error", (err) => this.logger.error(`MQTT error: ${err.message}`));
    this.client.on("message", (topic, payload) => this.handleMessage(topic, payload));
  }

  async onModuleDestroy(): Promise<void> {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
    }
    this.pending.clear();

    if (this.client) {
      const client = this.client;
      await new Promise<void>((resolve) => client.end(false, {}, () => resolve()));
      this.client = null;
    }
  }

  isConfigured(): boolean {
    return !!this.mqttUrl;
  }

  isConnected(): boolean {
    return !!this.client?.connected;
  }

  getPresence(deviceId: string): DevicePresence | undefined {
    return this.presence.get(deviceId);
  }

  listPresence(): DevicePresence[] {
    return [...this.presence.values()];
  }

  publish(topic: string, payload: unknown, opts?: { qos?: 0 | 1 | 2; retain?: boolean }): void {
    if (!this.client) {
      throw new Error("MQTT client is not connected (MQTT_URL not set)");
    }
    const body = typeof payload === "string" ? payload : JSON.stringify(payload);
    this.client.publish(topic, body, { qos: opts?.qos ?? 0, retain: opts?.retain ?? false });
  }

  /**
   * Sends a real capability-call command to a device and awaits the matching
   * response, using the exact protocol verified live against a real device
   * and a real broker this session (PHASE1-ANALYSIS.md §C): publish
   * {id, action:"capability", name, input} to the device's `command` topic,
   * resolve when a {id, ok, result} response arrives on `response`, or
   * reject on timeout.
   */
  sendCommand(
    deviceId: string,
    command: { name: string; input?: Record<string, unknown> },
    options?: { baseTopic?: string; timeoutMs?: number },
  ): Promise<ResponseEnvelope> {
    if (!this.client) {
      return Promise.reject(new Error("MQTT client is not connected (MQTT_URL not set)"));
    }
    const timeoutMs = options?.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    const id = randomUUID();
    const envelope: CommandEnvelope = {
      id,
      action: "capability",
      name: command.name,
      input: command.input ?? {},
    };
    // options?.baseTopic left undefined here lets TopicService.build() apply
    // its own configured default (MQTT_BASE_TOPIC_PREFIX) — passing an empty
    // string instead would incorrectly bypass that default and fail
    // buildTopic()'s own non-empty validation.
    const commandTopic = options?.baseTopic
      ? this.topics.build(deviceId, "command", options.baseTopic)
      : this.topics.build(deviceId, "command");

    return new Promise<ResponseEnvelope>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Command ${id} to device ${deviceId} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      try {
        this.publish(commandTopic, envelope, { qos: 1 });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err as Error);
      }
    });
  }

  private handleMessage(topic: string, payload: Buffer): void {
    const parsed = this.topics.parse(topic);
    if (!parsed) {
      return;
    }

    let json: unknown;
    try {
      json = JSON.parse(payload.toString("utf8"));
    } catch {
      this.logger.debug(`Ignoring non-JSON payload on ${topic}`);
      return;
    }

    if (parsed.leaf === "status") {
      this.handleStatus(parsed.deviceId, parsed.baseTopic, json);
    } else if (parsed.leaf === "response") {
      this.handleResponse(json);
    }
  }

  private handleStatus(deviceId: string, baseTopic: string, json: unknown): void {
    try {
      const status = parseStatusEnvelope(json);
      this.presence.set(deviceId, {
        deviceId,
        online: status.online,
        lastSeenAt: new Date().toISOString(),
      });
      // Decoupled from DevicesService on purpose (PHASE5-DATABASE.md) — this
      // module doesn't know or care who's listening.
      const event: DeviceStatusEvent = { deviceId, baseTopic, online: status.online };
      this.events.emit(DEVICE_STATUS_EVENT, event);
    } catch {
      this.logger.debug(`Ignoring malformed status envelope for device ${deviceId}`);
    }
  }

  private handleResponse(json: unknown): void {
    let response: ResponseEnvelope;
    try {
      response = parseResponseEnvelope(json);
    } catch {
      this.logger.debug("Ignoring malformed response envelope");
      return;
    }
    const pending = this.pending.get(response.id);
    if (!pending) {
      // No one waiting — a stray/duplicate/late reply. Fine to drop.
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(response.id);
    pending.resolve(response);
  }
}
