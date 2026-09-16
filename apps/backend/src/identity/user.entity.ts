import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from "typeorm";

/**
 * Single-tenant on purpose (Architecture Evolution §22): no `orgId` yet,
 * matching the same "don't add a placeholder FK before multi-tenancy is
 * real" discipline already applied to `Device` (see device.entity.ts).
 * `role` is a plain string, not a permissions table — RBAC/Policies (§12)
 * is new work for once there's more than one role to actually distinguish.
 */
export type UserRole = "admin";

@Entity({ name: "users" })
export class User {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar", length: 255, unique: true })
  email!: string;

  @Column({ type: "varchar", length: 255 })
  passwordHash!: string;

  @Column({ type: "varchar", length: 32, default: "admin" })
  role!: UserRole;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt!: Date;
}
