import { Controller, Get, NotFoundException, Param } from "@nestjs/common";
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
}
