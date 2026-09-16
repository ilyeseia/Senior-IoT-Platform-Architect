import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server, type AddressInfo } from "node:net";
import Aedes from "aedes";
import mqtt, { type MqttClient } from "mqtt";
import type { ConfigService } from "@nestjs/config";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { MqttService } from "../../src/mqtt/mqtt.service";
import { TopicService } from "../../src/esp-claw/topic.service";
import { DEVICE_STATUS_EVENT, DeviceStatusEvent } from "../../src/mqtt/mqtt.events";
import type { Env } from "../../src/config/env.validation";

/**
 * No real broker/credentials are used anywhere in this file — it spins up a
 * local, in-process MQTT broker (aedes) on an ephemeral port and a simulated
 * device client, then proves MqttService's real protocol logic (presence
 * tracking, command/response correlation, timeout) end-to-end. Verifying the
 * SAME logic against the real CloudAMQP broker + a real device is a separate,
 * manual step documented in docs/architecture/PHASE4-MQTT.md, since that
 * requires the real MQTT_URL/credentials which this codebase never holds.
 */

function fakeConfig(values: Partial<Env>): ConfigService<Env, true> {
  return { get: (key: keyof Env) => values[key] } as unknown as ConfigService<Env, true>;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitUntil: condition not met within timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("MqttService (integration, real protocol, local test broker)", () => {
  const baseTopic = "espclaw";
  const deviceId = "ecda3b4ff7d4"; // the real device id used on hardware all session

  let broker: ReturnType<typeof Aedes>;
  let server: Server;
  let deviceClient: MqttClient;
  let service: MqttService;
  let events: EventEmitter2;

  let brokerUrl: string;

  beforeAll(async () => {
    broker = Aedes();
    server = createServer(broker.handle);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;
    const url = `mqtt://localhost:${port}`;
    brokerUrl = url;

    const topics = new TopicService(fakeConfig({ MQTT_BASE_TOPIC_PREFIX: baseTopic }));
    events = new EventEmitter2();
    service = new MqttService(fakeConfig({ MQTT_URL: url }), topics, events);
    service.onModuleInit();
    await waitUntil(() => service.isConnected());

    // Simulated ESP-Claw device: subscribes to its own command topic and
    // replies exactly like the real firmware's cap_mqtt bridge does — except
    // for "will_never_reply", used below to exercise the timeout path.
    deviceClient = mqtt.connect(url);
    await new Promise<void>((resolve) => deviceClient.on("connect", () => resolve()));
    deviceClient.subscribe(`${baseTopic}/${deviceId}/command`);
    deviceClient.on("message", (_topic, payload) => {
      const cmd = JSON.parse(payload.toString("utf8"));
      if (cmd.name === "will_never_reply") {
        return;
      }
      deviceClient.publish(
        `${baseTopic}/${deviceId}/response`,
        JSON.stringify({ id: cmd.id, capability: cmd.name, ok: true, result: "42" }),
      );
    });
  });

  afterAll(async () => {
    await service.onModuleDestroy();
    deviceClient.end(true);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("tracks presence from the real birth-message shape, and emits device.status for DevicesService", async () => {
    const received: DeviceStatusEvent[] = [];
    events.once(DEVICE_STATUS_EVENT, (e: DeviceStatusEvent) => received.push(e));

    deviceClient.publish(`${baseTopic}/${deviceId}/status`, JSON.stringify({ online: true }), {
      retain: true,
    });
    await waitUntil(() => service.getPresence(deviceId)?.online === true);
    expect(service.listPresence()).toContainEqual(
      expect.objectContaining({ deviceId, online: true }),
    );
    expect(received).toContainEqual({ deviceId, baseTopic, online: true });
  });

  it("updates presence to offline on the real LWT payload shape", async () => {
    deviceClient.publish(`${baseTopic}/${deviceId}/status`, JSON.stringify({ online: false }), {
      retain: true,
    });
    await waitUntil(() => service.getPresence(deviceId)?.online === false);
  });

  it("sends a real capability command and resolves with the device's response", async () => {
    const res = await service.sendCommand(deviceId, { name: "get_current_time" });
    expect(res.ok).toBe(true);
    expect(res.result).toBe("42");
    expect(res.capability).toBe("get_current_time");
  });

  it("rejects when no response arrives before the timeout", async () => {
    await expect(
      service.sendCommand(deviceId, { name: "will_never_reply" }, { timeoutMs: 200 }),
    ).rejects.toThrow(/timed out/);
  });

  it("respects an explicit tenant-scoped baseTopic override", async () => {
    // A dedicated client, deliberately NOT sharing `deviceClient`'s "message"
    // listener (mqtt.js delivers every incoming message to every listener on
    // a client regardless of which subscription matched, so reusing
    // `deviceClient` here would make its default-baseTopic handler from
    // beforeAll() race this one for the same command id).
    const tenantBase = "espclaw/acme-farms";
    const tenantDevice = mqtt.connect(brokerUrl);
    await new Promise<void>((resolve) => tenantDevice.on("connect", () => resolve()));
    tenantDevice.subscribe(`${tenantBase}/${deviceId}/command`);
    tenantDevice.on("message", (_topic, payload) => {
      const cmd = JSON.parse(payload.toString("utf8"));
      tenantDevice.publish(
        `${tenantBase}/${deviceId}/response`,
        JSON.stringify({ id: cmd.id, capability: cmd.name, ok: true, result: "tenant-ok" }),
      );
    });

    try {
      const res = await service.sendCommand(
        deviceId,
        { name: "mqtt_status" },
        { baseTopic: tenantBase },
      );
      expect(res.result).toBe("tenant-ok");
    } finally {
      tenantDevice.end(true);
    }
  });
});
