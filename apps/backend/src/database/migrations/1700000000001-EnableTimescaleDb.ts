import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Enables the extension now (matching the PostgreSQL+TimescaleDB decision in
 * PHASE1-ANALYSIS.md §F) without creating any hypertable yet — telemetry/
 * events/logs/audit_logs hypertables land in whichever later phase actually
 * introduces those tables (they don't exist in ESP-Claw's real firmware yet
 * either — see §0). Nothing in Phase 5 needs Timescale-specific behavior;
 * `devices`/`commands`/`command_results` are plain relational tables.
 */
export class EnableTimescaleDb1700000000001 implements MigrationInterface {
  name = "EnableTimescaleDb1700000000001";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS timescaledb;`);
  }

  public async down(): Promise<void> {
    // Deliberately not dropping the extension on rollback — safe/inexpensive
    // to leave enabled, and dropping it would be destructive if any later
    // migration already created a hypertable depending on it.
  }
}
