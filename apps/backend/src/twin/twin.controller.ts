import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Put } from "@nestjs/common";
import { DevicesService } from "../devices/devices.service";
import { TwinService } from "./twin.service";

@Controller("devices/:id/shadow")
export class TwinController {
  constructor(
    private readonly devices: DevicesService,
    private readonly twin: TwinService,
  ) {}

  @Get()
  async get(@Param("id") id: string) {
    await this.assertDeviceExists(id);
    return this.twin.getShadow(id);
  }

  @Put("desired")
  async setDesired(@Param("id") id: string, @Body() body: unknown) {
    await this.assertDeviceExists(id);
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new BadRequestException("body must be a JSON object of desired key/value pairs");
    }
    return this.twin.setDesired(id, body as Record<string, unknown>);
  }

  private async assertDeviceExists(id: string): Promise<void> {
    const device = await this.devices.findOne(id);
    if (!device) {
      throw new NotFoundException(`Device ${id} not found`);
    }
  }
}
