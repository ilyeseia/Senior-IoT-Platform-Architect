import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { TelemetrySample } from "./telemetry-sample.entity";
import { TelemetryService } from "./telemetry.service";
import { TelemetryController } from "./telemetry.controller";
import { TelemetryPollerService } from "./telemetry-poller.service";
import { DevicesModule } from "../devices/devices.module";
import { CommandsModule } from "../commands/commands.module";
import { TwinModule } from "../twin/twin.module";

@Module({
  imports: [TypeOrmModule.forFeature([TelemetrySample]), DevicesModule, CommandsModule, TwinModule],
  controllers: [TelemetryController],
  providers: [TelemetryService, TelemetryPollerService],
  exports: [TelemetryService],
})
export class TelemetryModule {}
