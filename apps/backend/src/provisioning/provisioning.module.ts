import { Module } from "@nestjs/common";
import { CommandsModule } from "../commands";
import { PlatformTokenService } from "./platform-token.service";
import { PrivilegedCommandsService } from "./privileged-commands.service";
import { ProvisioningController } from "./provisioning.controller";

/** Control-plane device security: per-device signing secrets and privileged (platform_exec) operations. */
@Module({
  imports: [CommandsModule],
  controllers: [ProvisioningController],
  providers: [PlatformTokenService, PrivilegedCommandsService],
})
export class ProvisioningModule {}
