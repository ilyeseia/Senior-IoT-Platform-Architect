import { Body, Controller, Get, NotFoundException, Param, Post } from "@nestjs/common";
import { DevicesService } from "./devices.service";

/**
 * The real Device Registry API (PHASE1-ANALYSIS.md §26), superseding
 * MqttController's /mqtt/presence debug view as the source of truth a
 * frontend (Phase 7) would actually use — /mqtt/presence stays as a
 * low-level view of the in-memory map for comparing against this
 * DB-backed one while developing.
 */
@Controller("devices")
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  @Get()
  findAll() {
    return this.devices.findAll();
  }

  @Get(":id")
  async findOne(@Param("id") id: string) {
    const device = await this.devices.findOne(id);
    if (!device) {
      throw new NotFoundException(`Device ${id} not found`);
    }
    return device;
  }

  /** Capability groups last discovered from this device's local /api/capabilities. */
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
  @Post(":id/capabilities/refresh")
  refreshCapabilities(@Param("id") id: string, @Body() body?: { baseUrl?: string }) {
    return this.devices.refreshCapabilities(id, body?.baseUrl);
  }
}
