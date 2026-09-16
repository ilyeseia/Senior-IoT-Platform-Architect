/**
 * Standalone TypeORM DataSource for the CLI (`typeorm migration:run`,
 * `migration:generate`) — outside NestJS's DI, so it loads .env itself.
 * DatabaseModule (used by the running app) configures the same entities/
 * migrations through Nest's ConfigModule instead of this file.
 */
import "dotenv/config";
import { DataSource } from "typeorm";
import { Device } from "../devices/device.entity";
import { DeviceCapability } from "../devices/device-capability.entity";
import { Command } from "../commands/command.entity";
import { CommandResult } from "../commands/command-result.entity";
import { TelemetrySample } from "../telemetry/telemetry-sample.entity";
import { User } from "../identity/user.entity";
import { DeviceShadow } from "../twin/device-shadow.entity";

export const AppDataSource = new DataSource({
  type: "postgres",
  url: process.env.DATABASE_URL,
  entities: [Device, DeviceCapability, Command, CommandResult, TelemetrySample, User, DeviceShadow],
  migrations: [__dirname + "/migrations/*.{js,ts}"],
  synchronize: false,
});
