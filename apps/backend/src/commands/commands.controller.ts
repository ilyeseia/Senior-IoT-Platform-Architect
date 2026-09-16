import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { CommandsService } from "./commands.service";

interface DispatchCommandDto {
  name: string;
  input?: Record<string, unknown>;
  baseTopic?: string;
  timeoutMs?: number;
}

/**
 * The real, DB-backed replacement for MqttController's debug send endpoint
 * (PHASE1-ANALYSIS.md §26) — this is what a frontend (Phase 7) or any
 * automation (Phase 11) would actually call to command a device.
 */
@Controller("devices/:deviceId/commands")
export class CommandsController {
  constructor(private readonly commands: CommandsService) {}

  @Post()
  dispatch(@Param("deviceId") deviceId: string, @Body() body: DispatchCommandDto) {
    return this.commands.dispatch(deviceId, body);
  }

  @Get()
  findAll(@Param("deviceId") deviceId: string) {
    return this.commands.findAllForDevice(deviceId);
  }
}
