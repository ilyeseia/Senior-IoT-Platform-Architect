import { randomUUID } from "crypto";
import { currentContext } from "../context/request-context";

/**
 * The standard event envelope (ADVANCED-ARCHITECTURE-AUDIT.md §20). Every event that crosses a
 * module boundary is one of these, so the transport can change (in-process today, NATS JetStream
 * later) without touching producers or consumers.
 *
 * Fields the platform does not populate yet are present and `null` rather than absent, so
 * consumers can rely on the shape:
 *  - organization_id: null until the identity module has organizations (Stage 2)
 *  - sequence: null until a per-device monotonic counter exists (needed for edge store-and-forward)
 *  - trace_id / span_id: taken from the W3C `traceparent` request header when present
 */
export interface DomainEvent<P = unknown> {
  /** Unique per event. Consumers dedupe on it (at-least-once delivery ⇒ duplicates are possible). */
  event_id: string;
  /** Dotted name from `EventTypes`, e.g. "device.command.completed". */
  event_type: string;
  /** Bumped on a breaking payload change so old and new consumers can coexist. */
  schema_version: number;
  /** When the thing happened (ISO 8601, UTC) — not when it was delivered. */
  timestamp: string;
  /** Subject device; also the ordering key (events of one device are delivered in order). */
  device_id: string | null;
  organization_id: string | null;
  /** Producer, e.g. "gateway:mqtt" or "module:devices". */
  source: string;
  /** Ties together everything caused by one API request / external stimulus. */
  correlation_id: string;
  /** The event or command that directly caused this one. */
  causation_id: string | null;
  trace_id: string | null;
  span_id: string | null;
  sequence: number | null;
  /** Set when a producer may retry the same logical event and consumers must collapse it. */
  idempotency_key: string | null;
  payload: P;
}

export interface CreateEventInput<P> {
  type: string;
  source: string;
  payload: P;
  deviceId?: string | null;
  causationId?: string | null;
  idempotencyKey?: string | null;
  /** Override the correlation id (default: the current request's, else a fresh one). */
  correlationId?: string;
  /** When it happened, if not "now". */
  occurredAt?: Date;
  schemaVersion?: number;
}

export function createEvent<P>(input: CreateEventInput<P>): DomainEvent<P> {
  const ctx = currentContext();
  return {
    event_id: randomUUID(),
    event_type: input.type,
    schema_version: input.schemaVersion ?? 1,
    timestamp: (input.occurredAt ?? new Date()).toISOString(),
    device_id: input.deviceId ?? null,
    organization_id: null,
    source: input.source,
    correlation_id: input.correlationId ?? ctx?.correlationId ?? randomUUID(),
    causation_id: input.causationId ?? null,
    trace_id: ctx?.traceId ?? null,
    span_id: ctx?.spanId ?? null,
    sequence: null,
    idempotency_key: input.idempotencyKey ?? null,
    payload: input.payload,
  };
}
