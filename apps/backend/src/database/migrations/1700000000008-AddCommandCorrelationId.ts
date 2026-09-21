import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Stage 1: ties a stored command to the API request (and event chain) that produced it, so
 * "who asked for this, and what else did that request cause" is answerable from the database.
 * Additive and nullable — existing rows simply have no correlation id. Rollback drops the column.
 */
export class AddCommandCorrelationId1700000000008 implements MigrationInterface {
  name = "AddCommandCorrelationId1700000000008";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "commands" ADD COLUMN "correlation_id" varchar(128);`);
    await queryRunner.query(`CREATE INDEX "IDX_commands_correlation_id" ON "commands" ("correlation_id");`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_commands_correlation_id";`);
    await queryRunner.query(`ALTER TABLE "commands" DROP COLUMN IF EXISTS "correlation_id";`);
  }
}
