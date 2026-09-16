/**
 * Standalone TypeORM DataSource for the CLI (`typeorm migration:run`,
 * `migration:generate`) — outside NestJS's DI, so it loads .env itself.
 * DatabaseModule (used by the running app) configures the same entities/
 * migrations through Nest's ConfigModule instead of this file.
 */
import "dotenv/config";
import { DataSource } from "typeorm";
import { Device } from "../devices/device.entity";
import { Command } from "../commands/command.entity";
import { CommandResult } from "../commands/command-result.entity";

export const AppDataSource = new DataSource({
  type: "postgres",
  url: process.env.DATABASE_URL,
  entities: [Device, Command, CommandResult],
  migrations: [__dirname + "/migrations/*.{js,ts}"],
  synchronize: false,
});
