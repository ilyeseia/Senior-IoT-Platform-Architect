import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { TypeOrmModule } from "@nestjs/typeorm";
import type { Env } from "../config/env.validation";

/**
 * Connection only. Each feature module registers the entities it owns through
 * `TypeOrmModule.forFeature([...])`, and `autoLoadEntities` collects them — so this module knows
 * nothing about any feature (before Stage 1 it imported every entity, which made the database
 * module depend on all of them). Migrations stay explicit and reviewable.
 */
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        type: "postgres" as const,
        url: config.get("DATABASE_URL", { infer: true }),
        autoLoadEntities: true,
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
