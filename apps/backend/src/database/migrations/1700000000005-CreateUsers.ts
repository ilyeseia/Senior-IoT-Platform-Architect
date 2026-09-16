import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Identity/Auth (Architecture Evolution §10 problem #2, §12, §22): the
 * platform's first authentication mechanism. Single-tenant, no `org_id` —
 * same reasoning as `devices` not having one yet (device.entity.ts).
 */
export class CreateUsers1700000000005 implements MigrationInterface {
  name = "CreateUsers1700000000005";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "users" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "email" varchar(255) NOT NULL,
        "passwordHash" varchar(255) NOT NULL,
        "role" varchar(32) NOT NULL DEFAULT 'admin',
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY ("id"),
        CONSTRAINT "UQ_users_email" UNIQUE ("email")
      );
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "users";`);
  }
}
