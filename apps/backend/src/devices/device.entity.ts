import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from "typeorm";

/**
 * The Device Registry (PHASE1-ANALYSIS.md §D), scoped to what's actually
 * populatable right now. org_id/project_id foreign keys are deliberately NOT
 * here yet — Organizations/Users/Projects don't exist until the Auth/
 * multi-tenancy phase lands; adding them via a later migration then is more
 * honest than nullable placeholder columns nobody reads or writes today.
 *
 * `id` is the real ESP-Claw device_id (MAC-derived hex, e.g. "ecda3b4ff7d4")
 * — not a generated UUID. It's already globally unique and free (verified
 * against real hardware all session), so there's no reason to wrap it in a
 * surrogate key.
 */
@Entity({ name: "devices" })
export class Device {
  @PrimaryColumn({ type: "varchar", length: 32 })
  id!: string;

  @Column({ type: "varchar", length: 255, nullable: true })
  deviceName!: string | null;

  /** The mqtt_base_topic value used to reach this device (tenant scoping — see PHASE1-ANALYSIS.md §0/§C). */
  @Column({ type: "varchar", length: 255 })
  baseTopic!: string;

  @Column({ type: "boolean", default: false })
  online!: boolean;

  @Column({ type: "timestamptz", nullable: true })
  lastSeenAt!: Date | null;

  /**
   * The device's local ESP-Claw HTTP base URL (its tailnet IP/host, e.g.
   * "http://100.108.45.150") used for one-shot introspection over the tailnet
   * (Phase 6). Nullable: unknown until an operator provides it or a refresh is
   * run with an explicit baseUrl. Never used for ongoing traffic — that's MQTT.
   */
  @Column({ type: "varchar", length: 255, nullable: true })
  localApiBaseUrl!: string | null;

  @Column({ type: "timestamptz", nullable: true })
  capabilitiesRefreshedAt!: Date | null;

  @CreateDateColumn({ type: "timestamptz" })
  firstSeenAt!: Date;

  @UpdateDateColumn({ type: "timestamptz" })
  updatedAt!: Date;
}
