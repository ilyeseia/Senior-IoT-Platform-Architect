import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from "typeorm";
import type { Role } from "../platform";

/**
 * Single-tenant on purpose (Architecture Evolution §22): no `orgId` yet, matching the same
 * "don't add a placeholder FK before multi-tenancy is real" discipline already applied to `Device`
 * (see device.entity.ts). `role` is one of ROLES (platform/auth/permissions.ts).
 */
@Entity({ name: "users" })
export class User {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar", length: 255, unique: true })
  email!: string;

  @Column({ type: "varchar", length: 255 })
  passwordHash!: string;

  @Column({ type: "varchar", length: 32, default: "admin" })
  role!: Role;

  /** Set = the account is disabled: no login, and its existing tokens stop working at once. */
  @Column({ type: "timestamptz", nullable: true })
  disabledAt!: Date | null;

  /** Embedded in each JWT as `tv`; bump to revoke every token issued so far. */
  @Column({ type: "integer", default: 0 })
  tokenVersion!: number;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt!: Date;
}
