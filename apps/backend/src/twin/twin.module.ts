import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { DeviceShadow } from "./device-shadow.entity";
import { TwinService } from "./twin.service";
import { TwinController } from "./twin.controller";
import { DevicesModule } from "../devices/devices.module";

@Module({
  imports: [TypeOrmModule.forFeature([DeviceShadow]), DevicesModule],
  controllers: [TwinController],
  providers: [TwinService],
  exports: [TwinService],
})
export class TwinModule {}
