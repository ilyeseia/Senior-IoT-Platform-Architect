/**
 * Standalone TypeORM DataSource for the CLI (`typeorm migration:run`,
 * `migration:generate`) — outside NestJS's DI, so it loads .env itself.
 * DatabaseModule (used by the running app) configures the same migrations through Nest's
 * ConfigModule and collects entities from the feature modules; here entities are found by naming
 * convention (`*.entity.ts` next to the module that owns them).
 */
import "dotenv/config";
import { DataSource } from "typeorm";

export const AppDataSource = new DataSource({
  type: "postgres",
  url: process.env.DATABASE_URL,
  entities: [__dirname + "/../**/*.entity.{js,ts}"],
  migrations: [__dirname + "/migrations/*.{js,ts}"],
  synchronize: false,
});
