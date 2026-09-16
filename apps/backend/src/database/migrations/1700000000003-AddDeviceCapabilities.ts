import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Phase 6 — ESP-Claw integration. Adds the device's local-API base URL and a
 * capabilities-refresh timestamp to `devices`, and a `device_capabilities`
 * table holding the capability groups pulled from a device's real
 * `GET /api/capabilities` (see PHASE1-ANALYSIS.md §K).
 */
export class AddDeviceCapabilities1700000000003 implements MigrationInterface {
  name = "AddDeviceCapabilities1700000000003";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "devices"
        ADD COLUMN "localApiBaseUrl" varchar(255),
        ADD COLUMN "capabilitiesRefreshedAt" timestamptz;
    `);

    await queryRunner.query(`
      CREATE TABLE "device_capabilities" (
        "device_id" varchar(32) NOT NULL REFERENCES "devices"("id") ON DELETE CASCADE,
        "groupId" varchar(64) NOT NULL,
        "displayName" varchar(128) NOT NULL DEFAULT '',
        "defaultLlmVisible" boolean NOT NULL DEFAULT false,
        "firstSeenAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY ("device_id", "groupId")
      );
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_device_capabilities_groupId" ON "device_capabilities" ("groupId");`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "device_capabilities";`);
    await queryRunner.query(`
      ALTER TABLE "devices"
        DROP COLUMN IF EXISTS "capabilitiesRefreshedAt",
        DROP COLUMN IF EXISTS "localApiBaseUrl";
    `);
  }
}
