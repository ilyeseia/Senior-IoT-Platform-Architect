import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Data Plane telemetry (ARCHITECTURE-EVOLUTION.md §13, Option B). The
 * `timescaledb` extension was enabled in migration 0001 with no hypertable to
 * convert yet — this is that hypertable, the first one in the project.
 */
export class CreateTelemetryHypertable1700000000004 implements MigrationInterface {
  name = "CreateTelemetryHypertable1700000000004";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "telemetry" (
        "device_id" varchar(32) NOT NULL REFERENCES "devices"("id") ON DELETE CASCADE,
        "metric" varchar(64) NOT NULL,
        "recorded_at" timestamptz NOT NULL,
        "value_numeric" double precision,
        "value_bool" boolean,
        "source" varchar(64) NOT NULL,
        PRIMARY KEY ("device_id", "metric", "recorded_at")
      );
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_telemetry_device_metric_time" ON "telemetry" ("device_id", "metric", "recorded_at" DESC);`,
    );
    // Partitions on recorded_at; the composite PK above already includes it,
    // which TimescaleDB requires for any PK/unique constraint on a hypertable.
    await queryRunner.query(`SELECT create_hypertable('telemetry', 'recorded_at', if_not_exists => true);`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Dropping a hypertable is a plain DROP TABLE — TimescaleDB handles chunk cleanup.
    await queryRunner.query(`DROP TABLE IF EXISTS "telemetry";`);
  }
}
