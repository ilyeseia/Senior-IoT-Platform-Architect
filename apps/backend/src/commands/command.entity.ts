import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from "typeorm";
import { Device } from "../devices/device.entity";

/**
 * "id" here is the SAME id used as the real command envelope's "id" field
 * over MQTT (PHASE1-ANALYSIS.md §C) — using one id end-to-end (not a
 * separate DB-generated key mapped to the wire id) keeps correlation trivial
 * to reason about and to look up from a raw MQTT log.
 */
export type CommandStatus = "pending" | "succeeded" | "failed" | "rejected" | "timed_out";

@Entity({ name: "commands" })
export class Command {
  @PrimaryColumn({ type: "uuid" })
  id!: string;

  @ManyToOne(() => Device, { onDelete: "CASCADE" })
  @JoinColumn({ name: "device_id" })
  device!: Device;

  @Column({ name: "device_id", type: "varchar", length: 32 })
  @Index()
  deviceId!: string;

  @Column({ type: "varchar", length: 255 })
  name!: string;

  @Column({ type: "jsonb", default: () => "'{}'::jsonb" })
  input!: Record<string, unknown>;

  @Column({ type: "varchar", length: 16, default: "pending" })
  @Index()
  status!: CommandStatus;

  @Column({ type: "integer" })
  timeoutMs!: number;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt!: Date;

  @Column({ type: "timestamptz", nullable: true })
  resolvedAt!: Date | null;
}
