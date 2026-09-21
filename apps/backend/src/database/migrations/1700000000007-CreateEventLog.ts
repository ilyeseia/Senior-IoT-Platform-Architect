import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Stage 1 (ADVANCED-ARCHITECTURE-AUDIT.md §20, §22, §29): the append-only event history. Additive —
 * a new table, nothing existing is touched. Rollback: `down()` drops it (data loss is limited to the
 * audit history itself).
 *
 * Append-only is enforced with triggers, so it holds for every writer (this service, psql, a future
 * service): UPDATE and DELETE are rejected per row and TRUNCATE per statement. `DROP TABLE` is not
 * blocked, which is what `down()` relies on.
 */
export class CreateEventLog1700000000007 implements MigrationInterface {
  name = "CreateEventLog1700000000007";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "event_log" (
        "event_id" uuid NOT NULL,
        "seq" bigserial NOT NULL,
        "event_type" varchar(96) NOT NULL,
        "schema_version" integer NOT NULL DEFAULT 1,
        "occurred_at" timestamptz NOT NULL,
        "recorded_at" timestamptz NOT NULL DEFAULT now(),
        "device_id" varchar(32),
        "organization_id" varchar(64),
        "source" varchar(96) NOT NULL,
        "correlation_id" varchar(128) NOT NULL,
        "causation_id" varchar(128),
        "trace_id" varchar(32),
        "span_id" varchar(16),
        "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
        PRIMARY KEY ("event_id"),
        CONSTRAINT "UQ_event_log_seq" UNIQUE ("seq")
      );
    `);
    await queryRunner.query(`CREATE INDEX "IDX_event_log_device_seq" ON "event_log" ("device_id", "seq" DESC);`);
    await queryRunner.query(`CREATE INDEX "IDX_event_log_type_seq" ON "event_log" ("event_type", "seq" DESC);`);
    await queryRunner.query(`CREATE INDEX "IDX_event_log_correlation" ON "event_log" ("correlation_id");`);

    await queryRunner.query(`
      CREATE FUNCTION "event_log_reject_change"() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'event_log is append-only (% is not allowed)', TG_OP;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await queryRunner.query(`
      CREATE TRIGGER "event_log_no_update_delete"
        BEFORE UPDATE OR DELETE ON "event_log"
        FOR EACH ROW EXECUTE FUNCTION "event_log_reject_change"();
    `);
    await queryRunner.query(`
      CREATE TRIGGER "event_log_no_truncate"
        BEFORE TRUNCATE ON "event_log"
        FOR EACH STATEMENT EXECUTE FUNCTION "event_log_reject_change"();
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "event_log";`); // drops its triggers with it
    await queryRunner.query(`DROP FUNCTION IF EXISTS "event_log_reject_change"();`);
  }
}
