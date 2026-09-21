import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { RequirePermission } from "../platform";
import { parseBody } from "../common/validation/parse-body";
import { dispatchCommandSchema } from "./commands.dto";
import { CommandsService } from "./commands.service";

/**
 * The DB-backed command API (PHASE1-ANALYSIS.md §26): the only operator-facing
 * way to command a device, and therefore the only path with an audit trail.
 */
@Controller("devices/:deviceId/commands")
export class CommandsController {
  constructor(private readonly commands: CommandsService) {}

  @RequirePermission("commands:dispatch")
  @Post()
  dispatch(@Param("deviceId") deviceId: string, @Body() body: unknown) {
    return this.commands.dispatch(deviceId, parseBody(dispatchCommandSchema, body));
  }

  @RequirePermission("commands:read")
  @Get()
  findAll(@Param("deviceId") deviceId: string) {
    return this.commands.findAllForDevice(deviceId);
  }
}
