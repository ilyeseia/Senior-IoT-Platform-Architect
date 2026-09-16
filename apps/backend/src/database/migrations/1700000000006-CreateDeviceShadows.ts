import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Digital Twin (ARCHITECTURE-EVOLUTION.md §18): one shadow row per device,
 * created lazily (see twin.service.ts) rather than for every device up
 * front — a device with no reported data and no operator-set desired state
 * has nothing worth a row for yet.
 */
export class CreateDeviceShadows1700000000006 implements MigrationInterface {
  name = "CreateDeviceShadows1700000000006";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "device_shadows" (
        "deviceId" varchar(32) NOT NULL REFERENCES "devices"("id") ON DELETE CASCADE,
        "desired" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "reported" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "desiredVersion" integer NOT NULL DEFAULT 0,
        "reportedVersion" integer NOT NULL DEFAULT 0,
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY ("deviceId")
      );
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "device_shadows";`);
  }
}
