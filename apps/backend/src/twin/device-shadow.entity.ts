import { Column, Entity, JoinColumn, OneToOne, PrimaryColumn, UpdateDateColumn } from "typeorm";
import { Device } from "../devices/device.entity";

/**
 * Digital Twin / Device Shadow (ARCHITECTURE-EVOLUTION.md §18). `desired` and
 * `reported` are flat, same-key-name objects by design — matches the doc's
 * own example (`desired.sampling_interval` vs `reported.sampling_interval`),
 * so drift detection is a plain per-key comparison, not a schema mapping.
 *
 * `reported` is populated ONLY from what ESP-Claw actually reports today —
 * the same scalar fields TelemetryPollerService already extracts from
 * mqtt_status/vpn_status/network_status/ota_status (see twin.service.ts).
 * `desired` is operator-authored via the Twin API. There is deliberately no
 * reconciliation/auto-push loop in this pass — see IDENTITY-AUTH.md-style
 * "not done" note in DIGITAL-TWIN.md: pushing `desired` to a device is a
 * separate, later decision (gated on cap_platform for restricted fields).
 */
@Entity({ name: "device_shadows" })
export class DeviceShadow {
  @PrimaryColumn({ type: "varchar", length: 32 })
  deviceId!: string;

  @OneToOne(() => Device, { onDelete: "CASCADE" })
  @JoinColumn({ name: "deviceId" })
  device!: Device;

  @Column({ type: "jsonb", default: () => "'{}'::jsonb" })
  desired!: Record<string, unknown>;

  @Column({ type: "jsonb", default: () => "'{}'::jsonb" })
  reported!: Record<string, unknown>;

  @Column({ type: "integer", default: 0 })
  desiredVersion!: number;

  @Column({ type: "integer", default: 0 })
  reportedVersion!: number;

  @UpdateDateColumn({ type: "timestamptz" })
  updatedAt!: Date;
}
