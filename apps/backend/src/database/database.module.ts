import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { TypeOrmModule } from "@nestjs/typeorm";
import { Device } from "../devices/device.entity";
import { DeviceCapability } from "../devices/device-capability.entity";
import { Command } from "../commands/command.entity";
import { CommandResult } from "../commands/command-result.entity";
import { TelemetrySample } from "../telemetry/telemetry-sample.entity";
import type { Env } from "../config/env.validation";

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        type: "postgres" as const,
        url: config.get("DATABASE_URL", { infer: true }),
        entities: [Device, DeviceCapability, Command, CommandResult, TelemetrySample],
        // Migrations only, never auto-sync — schema changes are explicit,
        // reviewable, and reversible (item 33's reliability spirit applies
        // to schema changes too, not just runtime retries).
        synchronize: false,
        migrationsRun: true,
        migrations: [__dirname + "/migrations/*.{js,ts}"],
      }),
    }),
  ],
})
export class DatabaseModule {}
