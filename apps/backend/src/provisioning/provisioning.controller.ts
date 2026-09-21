import { Body, Controller, Get, Param, Post, Req } from "@nestjs/common";
import { z } from "zod";
import { RequirePermission } from "../platform";
import { parseBody } from "../common/validation/parse-body";
import { PLATFORM_EXEC_TARGETS } from "./platform-exec";
import { PlatformTokenService } from "./platform-token.service";
import { PrivilegedCommandsService } from "./privileged-commands.service";

const executeSchema = z
  .object({
    capability: z.enum(PLATFORM_EXEC_TARGETS),
    input: z.record(z.unknown()).default({}),
    timeoutMs: z.number().int().min(1000).max(60_000).optional(),
  })
  .strict();

/**
 * Privileged device operations (OTA, network / MQTT / VPN configuration, agent inspection). Admin
 * only (`devices:privileged`); every execution is recorded twice — as a command (secrets redacted)
 * and as an audited `security.privileged.executed` event naming who did it.
 */
@Controller()
export class ProvisioningController {
  constructor(
    private readonly privileged: PrivilegedCommandsService,
    private readonly tokens: PlatformTokenService,
  ) {}

  @Get("privileged/targets")
  @RequirePermission("devices:privileged")
  targets() {
    return { configured: this.tokens.isConfigured(), targets: PLATFORM_EXEC_TARGETS };
  }

  @Post("devices/:deviceId/privileged")
  @RequirePermission("devices:privileged")
  execute(@Param("deviceId") deviceId: string, @Body() body: unknown, @Req() req: { user: { sub: string } }) {
    const { capability, input, timeoutMs } = parseBody(executeSchema, body);
    return this.privileged.execute(deviceId, capability, input, req.user.sub, timeoutMs);
  }
}
