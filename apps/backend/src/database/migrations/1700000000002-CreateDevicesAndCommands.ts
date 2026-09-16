import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateDevicesAndCommands1700000000002 implements MigrationInterface {
  name = "CreateDevicesAndCommands1700000000002";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "devices" (
        "id" varchar(32) PRIMARY KEY,
        "deviceName" varchar(255),
        "baseTopic" varchar(255) NOT NULL,
        "online" boolean NOT NULL DEFAULT false,
        "lastSeenAt" timestamptz,
        "firstSeenAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      );
    `);

    await queryRunner.query(`
      CREATE TABLE "commands" (
        "id" uuid PRIMARY KEY,
        "device_id" varchar(32) NOT NULL REFERENCES "devices"("id") ON DELETE CASCADE,
        "name" varchar(255) NOT NULL,
        "input" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "status" varchar(16) NOT NULL DEFAULT 'pending',
        "timeoutMs" integer NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "resolvedAt" timestamptz
      );
    `);
    await queryRunner.query(`CREATE INDEX "IDX_commands_device_id" ON "commands" ("device_id");`);
    await queryRunner.query(`CREATE INDEX "IDX_commands_status" ON "commands" ("status");`);

    await queryRunner.query(`
      CREATE TABLE "command_results" (
        "commandId" uuid PRIMARY KEY REFERENCES "commands"("id") ON DELETE CASCADE,
        "ok" boolean NOT NULL,
        "result" text,
        "receivedAt" timestamptz NOT NULL
      );
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "command_results";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "commands";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "devices";`);
  }
}
