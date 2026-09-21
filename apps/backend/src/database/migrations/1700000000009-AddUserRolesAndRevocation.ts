import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Stage 2 (RBAC): lets an account be disabled and lets all of its issued tokens be revoked at once.
 *  - "disabledAt": set = the account cannot log in and existing tokens stop working immediately.
 *  - "tokenVersion": embedded in every JWT (`tv`); bumped on password change/reset and on disabling,
 *    so old tokens are rejected even though they have not expired.
 * Additive with safe defaults: every existing user stays enabled at version 0, and tokens issued
 * before this migration (which carry no `tv`) are treated as version 0, so they keep working until
 * the first revocation. `role` already exists as varchar(32); "operator" and "viewer" need no DDL.
 * Rollback drops the two columns.
 */
export class AddUserRolesAndRevocation1700000000009 implements MigrationInterface {
  name = "AddUserRolesAndRevocation1700000000009";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users"
        ADD COLUMN "disabledAt" timestamptz,
        ADD COLUMN "tokenVersion" integer NOT NULL DEFAULT 0;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users"
        DROP COLUMN IF EXISTS "tokenVersion",
        DROP COLUMN IF EXISTS "disabledAt";
    `);
  }
}
