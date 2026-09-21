import { Column, Entity, Index, PrimaryColumn } from "typeorm";

/**
 * Append-only history of important events (ADVANCED-ARCHITECTURE-AUDIT.md §22: partial event
 * sourcing for device lifecycle, commands, OTA, security, configuration, important state changes).
 * NOT a general event store and NOT the source of truth for current state — the relational tables
 * are. Immutability is enforced by the database itself (triggers in migration 0007), not only by
 * convention: a bug or a compromised credential in this service still cannot rewrite history.
 *
 * `event_id` is the primary key, which makes recording idempotent (at-least-once delivery may hand
 * the same event over twice). `seq` gives a stable, gap-tolerant cursor for pagination.
 */
@Entity({ name: "event_log" })
@Index("IDX_event_log_device_seq", ["deviceId", "seq"])
@Index("IDX_event_log_type_seq", ["eventType", "seq"])
@Index("IDX_event_log_correlation", ["correlationId"])
export class EventLogRecord {
  @PrimaryColumn({ name: "event_id", type: "uuid" })
  eventId!: string;

  /** Monotonic insertion order. Read-only: assigned by the database. */
  @Column({ type: "bigint", insert: false, update: false })
  seq!: string;

  @Column({ name: "event_type", type: "varchar", length: 96 })
  eventType!: string;

  @Column({ name: "schema_version", type: "integer", default: 1 })
  schemaVersion!: number;

  /** When it happened (producer's clock), not when it was recorded. */
  @Column({ name: "occurred_at", type: "timestamptz" })
  occurredAt!: Date;

  @Column({ name: "recorded_at", type: "timestamptz", default: () => "now()", insert: false, update: false })
  recordedAt!: Date;

  @Column({ name: "device_id", type: "varchar", length: 32, nullable: true })
  deviceId!: string | null;

  @Column({ name: "organization_id", type: "varchar", length: 64, nullable: true })
  organizationId!: string | null;

  @Column({ type: "varchar", length: 96 })
  source!: string;

  @Column({ name: "correlation_id", type: "varchar", length: 128 })
  correlationId!: string;

  @Column({ name: "causation_id", type: "varchar", length: 128, nullable: true })
  causationId!: string | null;

  @Column({ name: "trace_id", type: "varchar", length: 32, nullable: true })
  traceId!: string | null;

  @Column({ name: "span_id", type: "varchar", length: 16, nullable: true })
  spanId!: string | null;

  @Column({ type: "jsonb", default: () => "'{}'::jsonb" })
  payload!: Record<string, unknown>;
}
