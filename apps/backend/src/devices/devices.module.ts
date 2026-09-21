import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { Device } from "./device.entity";
import { DeviceCapability } from "./device-capability.entity";
import { DevicesService } from "./devices.service";
import { DevicesController } from "./devices.controller";
import { EspClawModule } from "../esp-claw";

@Module({
  imports: [TypeOrmModule.forFeature([Device, DeviceCapability]), EspClawModule],
  controllers: [DevicesController],
  providers: [DevicesService],
  exports: [DevicesService],
})
export class DevicesModule {}
