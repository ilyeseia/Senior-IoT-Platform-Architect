import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { Command } from "./command.entity";
import { CommandResult } from "./command-result.entity";
import { CommandsService } from "./commands.service";
import { CommandsController } from "./commands.controller";
import { MqttModule } from "../mqtt";
import { DevicesModule } from "../devices";

@Module({
  imports: [TypeOrmModule.forFeature([Command, CommandResult]), MqttModule, DevicesModule],
  controllers: [CommandsController],
  providers: [CommandsService],
  exports: [CommandsService],
})
export class CommandsModule {}
