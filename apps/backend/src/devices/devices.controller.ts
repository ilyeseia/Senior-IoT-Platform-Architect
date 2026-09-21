import { Body, Controller, Get, NotFoundException, Param, Post } from "@nestjs/common";
import { RequirePermission } from "../platform";
import { z } from "zod";
import { parseBody } from "../common/validation/parse-body";
import { DevicesService } from "./devices.service";

const refreshCapabilitiesSchema = z.object({ baseUrl: z.string().min(1).max(255).optional() }).strict();

/**
 * The real Device Registry API (PHASE1-ANALYSIS.md §26), the
 * source of truth a frontend (Phase 7) would use. (The old /mqtt/presence
 * debug view was removed in Stage 0 — see MqttModule.)
 */
@Controller("devices")
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  @RequirePermission("devices:read")
  @Get()
  findAll() {
    return this.devices.findAll();
  }

  @RequirePermission("devices:read")
  @Get(":id")
  async findOne(@Param("id") id: string) {
    const device = await this.devices.findOne(id);
    if (!device) {
      throw new NotFoundException(`Device ${id} not found`);
    }
    return device;
  }

  /** Capability groups last discovered from this device's local /api/capabilities. */
  @RequirePermission("devices:read")
  @Get(":id/capabilities")
  listCapabilities(@Param("id") id: string) {
    return this.devices.listCapabilities(id);
  }

  /**
   * Pull the device's capability catalog from its local HTTP API over the
   * tailnet and persist it (Phase 6). Body `{ baseUrl }` is the device's tailnet
   * host/URL (e.g. "http://100.108.45.150"); if omitted, the device's stored
   * localApiBaseUrl is used. Introspection only — never touches /api/config.
   */
  @RequirePermission("devices:write")
  @Post(":id/capabilities/refresh")
  refreshCapabilities(@Param("id") id: string, @Body() body?: unknown) {
    const parsed = parseBody(refreshCapabilitiesSchema, body ?? {});
    return this.devices.refreshCapabilities(id, parsed.baseUrl);
  }
}
