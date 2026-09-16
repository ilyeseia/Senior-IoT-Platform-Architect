import { Column, Entity, Index, PrimaryColumn } from "typeorm";

/**
 * Data Plane telemetry (ARCHITECTURE-EVOLUTION.md §13, Option B): one row per
 * scalar metric extracted from an existing capability call's result — not a
 * new device-facing mechanism. Narrow/long time-series shape (one row per
 * metric per timestamp) is the standard TimescaleDB pattern for a
 * heterogeneous fleet where devices don't all report the same fields.
 *
 * Composite primary key (deviceId, metric, recordedAt) — no surrogate key.
 * TimescaleDB hypertables don't require a single-column PK; any PK/unique
 * constraint that includes the partitioning column (recordedAt) works, and
 * this one lets a single poll (one recordedAt, many metrics) insert cleanly
 * without a generated id per row.
 */
@Entity({ name: "telemetry" })
@Index("IDX_telemetry_device_metric_time", ["deviceId", "metric", "recordedAt"])
export class TelemetrySample {
  @PrimaryColumn({ name: "device_id", type: "varchar", length: 32 })
  deviceId!: string;

  @PrimaryColumn({ type: "varchar", length: 64 })
  metric!: string;

  @PrimaryColumn({ name: "recorded_at", type: "timestamptz" })
  recordedAt!: Date;

  @Column({ name: "value_numeric", type: "double precision", nullable: true })
  valueNumeric!: number | null;

  @Column({ name: "value_bool", type: "boolean", nullable: true })
  valueBool!: boolean | null;

  /** The capability whose result this metric was extracted from, e.g. "mqtt_status". */
  @Column({ type: "varchar", length: 64 })
  source!: string;
}
