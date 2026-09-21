import type { DomainEvent } from "./domain-event";

/** DI token for the event bus port. Depend on this, never on a concrete bus. */
export const EVENT_BUS = "EVENT_BUS";

export type EventHandler = (event: DomainEvent) => void | Promise<void>;

export interface SubscribeOptions {
  /** Stable consumer name: appears in logs and metrics, and later becomes the durable-consumer name. */
  name: string;
  /** Extra attempts after a failure (default 0). Use only for idempotent handlers. */
  retries?: number;
  /** Base delay between attempts; doubles each retry (default 100 ms). */
  backoffMs?: number;
  /** Give up waiting for the handler after this long (default 10 s). */
  timeoutMs?: number;
}

/**
 * Port for internal platform events (audit §20). Semantics every adapter must honour, so modules
 * written against it keep working when the transport changes:
 *
 *  - **Asynchronous.** `publish` returns immediately; it is an enqueue, not "consumers are done".
 *    A handler must never be needed for the publisher to make progress.
 *  - **At-least-once.** A handler may see the same `event_id` twice (retries, redelivery) and must be idempotent.
 *  - **Per-device ordering.** Events with the same `device_id` are delivered one after another, in
 *    publish order. Events of different devices may be processed concurrently.
 *  - **Isolated failures.** A failing or slow handler never affects the publisher or other handlers.
 *
 * The in-process adapter gives no durability across a crash; anything that must survive one is also
 * recorded by the audit module's append-only event log.
 */
export interface EventBus {
  publish(event: DomainEvent): void;
  /** `pattern`: dotted, `*` = one segment, `**` = the rest (e.g. "device.command.*", "device.**", "**"). Returns an unsubscribe function. */
  subscribe(pattern: string, handler: EventHandler, options: SubscribeOptions): () => void;
  /** Resolves when everything published so far has been delivered. For tests and orderly shutdown. */
  drain(): Promise<void>;
}
