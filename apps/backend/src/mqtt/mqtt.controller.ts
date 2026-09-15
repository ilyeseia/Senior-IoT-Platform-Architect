import { BadRequestException, Body, Controller, Get, Param, Post } from "@nestjs/common";
import { MqttService } from "./mqtt.service";

interface SendCommandBody {
  name: string;
  input?: Record<string, unknown>;
  baseTopic?: string;
  timeoutMs?: number;
}

/**
 * Debug/acceptance-test endpoints for Phase 4. Not the final Command
 * Service API (that's a later refinement with DB-backed history, auth, and
 * bulk/group targeting) — this is deliberately the smallest possible surface
 * to prove the real MQTT round-trip end-to-end against a real broker/device.
 */
@Controller("mqtt")
export class MqttController {
  constructor(private readonly mqtt: MqttService) {}

  @Get("status")
  status() {
    return {
      configured: this.mqtt.isConfigured(),
      connected: this.mqtt.isConnected(),
    };
  }

  @Get("presence")
  listPresence() {
    return this.mqtt.listPresence();
  }

  @Get("presence/:deviceId")
  getPresence(@Param("deviceId") deviceId: string) {
    return this.mqtt.getPresence(deviceId) ?? { deviceId, online: false, lastSeenAt: null };
  }

  @Post("devices/:deviceId/commands")
  async sendCommand(@Param("deviceId") deviceId: string, @Body() body: SendCommandBody) {
    if (!body?.name) {
      throw new BadRequestException("'name' (capability to call) is required");
    }
    return this.mqtt.sendCommand(
      deviceId,
      { name: body.name, input: body.input },
      { baseTopic: body.baseTopic, timeoutMs: body.timeoutMs },
    );
  }
}
