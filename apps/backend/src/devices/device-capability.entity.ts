import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from "typeorm";

/**
 * A capability *group* a device reports via its local `GET /api/capabilities`
 * (PHASE1-ANALYSIS.md §K, Phase 6). One row per (device, group) — e.g.
 * ("ecda3b4ff7d4", "cap_mqtt"). Deliberately models only what the firmware
 * actually exposes (group_id + display name + default LLM visibility); there is
 * no per-tool descriptor table because the device doesn't expose per-tool
 * descriptors over HTTP.
 *
 * The `groupId` index answers the fleet question "which devices have cap_ota?".
 */
@Entity({ name: "device_capabilities" })
export class DeviceCapability {
  @PrimaryColumn({ name: "device_id", type: "varchar", length: 32 })
  deviceId!: string;

  @PrimaryColumn({ name: "groupId", type: "varchar", length: 64 })
  @Index("IDX_device_capabilities_groupId")
  groupId!: string;

  @Column({ name: "displayName", type: "varchar", length: 128, default: "" })
  displayName!: string;

  @Column({ name: "defaultLlmVisible", type: "boolean", default: false })
  defaultLlmVisible!: boolean;

  @CreateDateColumn({ name: "firstSeenAt", type: "timestamptz" })
  firstSeenAt!: Date;

  @UpdateDateColumn({ name: "updatedAt", type: "timestamptz" })
  updatedAt!: Date;
}
