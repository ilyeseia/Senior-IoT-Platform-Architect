import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import type { DomainEvent } from "./domain-event";
import type { EventBus, EventHandler, SubscribeOptions } from "./event-bus";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_BACKOFF_MS = 100;
/** Events without a device (system-level) share one ordering lane. */
const GLOBAL_LANE = "_global";
const SHUTDOWN_DRAIN_MS = 5_000;

interface Subscription {
  pattern: string;
  handler: EventHandler;
  name: string;
  retries: number;
  backoffMs: number;
  timeoutMs: number;
}

export interface EventBusStats {
  published: number;
  delivered: number;
  failed: number;
  timedOut: number;
}

/** True if a dotted event type matches a pattern (`*` = exactly one segment, `**` = one or more remaining segments). */
export function matchesPattern(pattern: string, type: string): boolean {
  const p = pattern.split(".");
  const t = type.split(".");
  for (let i = 0; i < p.length; i++) {
    if (p[i] === "**") {
      return t.length > i;
    }
    if (i >= t.length) {
      return false;
    }
    if (p[i] !== "*" && p[i] !== t[i]) {
      return false;
    }
  }
  return p.length === t.length;
}

/**
 * The in-process adapter of the EventBus port: enough for a single backend instance, and the
 * reason producers and consumers already speak envelopes. Ordering is achieved by chaining
 * deliveries per device; a failing handler is logged (and retried if it asked to be) but never
 * propagates. It is replaced — not extended — by a NATS JetStream adapter when the triggers in
 * ADVANCED-ARCHITECTURE-AUDIT.md §20 are met.
 */
@Injectable()
export class InProcessEventBus implements EventBus, OnModuleDestroy {
  private readonly logger = new Logger("EventBus");
  private readonly subscriptions: Subscription[] = [];
  private readonly lanes = new Map<string, Promise<void>>();
  private readonly inFlight = new Set<Promise<void>>();
  private readonly counters: EventBusStats = { published: 0, delivered: 0, failed: 0, timedOut: 0 };

  publish(event: DomainEvent): void {
    this.counters.published++;
    const targets = this.subscriptions.filter((s) => matchesPattern(s.pattern, event.event_type));
    if (targets.length === 0) {
      return;
    }
    const lane = event.device_id ?? GLOBAL_LANE;
    const previous = this.lanes.get(lane) ?? Promise.resolve();
    // deliver() never rejects, so the chain can never get stuck on a failed link.
    const current = previous.then(() => this.deliver(event, targets));
    this.lanes.set(lane, current);
    this.inFlight.add(current);
    void current.finally(() => {
      this.inFlight.delete(current);
      if (this.lanes.get(lane) === current) {
        this.lanes.delete(lane);
      }
    });
  }

  subscribe(pattern: string, handler: EventHandler, options: SubscribeOptions): () => void {
    const subscription: Subscription = {
      pattern,
      handler,
      name: options.name,
      retries: options.retries ?? 0,
      backoffMs: options.backoffMs ?? DEFAULT_BACKOFF_MS,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    };
    this.subscriptions.push(subscription);
    return () => {
      const index = this.subscriptions.indexOf(subscription);
      if (index >= 0) {
        this.subscriptions.splice(index, 1);
      }
    };
  }

  async drain(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
  }

  stats(): EventBusStats {
    return { ...this.counters };
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.race([this.drain(), new Promise((resolve) => setTimeout(resolve, SHUTDOWN_DRAIN_MS))]);
  }

  private async deliver(event: DomainEvent, targets: Subscription[]): Promise<void> {
    await Promise.all(targets.map((s) => this.runHandler(s, event)));
  }

  private async runHandler(sub: Subscription, event: DomainEvent): Promise<void> {
    for (let attempt = 0; attempt <= sub.retries; attempt++) {
      try {
        await this.withTimeout(sub, event);
        this.counters.delivered++;
        return;
      } catch (err) {
        const last = attempt === sub.retries;
        this.logger.warn(
          `handler "${sub.name}" failed for ${event.event_type} ${event.event_id} ` +
            `(attempt ${attempt + 1}/${sub.retries + 1}, correlation ${event.correlation_id}): ${(err as Error).message}`,
        );
        if (last) {
          this.counters.failed++;
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, sub.backoffMs * 2 ** attempt));
      }
    }
  }

  private withTimeout(sub: Subscription, event: DomainEvent): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.counters.timedOut++;
        reject(new Error(`timed out after ${sub.timeoutMs} ms`));
      }, sub.timeoutMs);
      Promise.resolve()
        .then(() => sub.handler(event))
        .then(resolve, reject)
        .finally(() => clearTimeout(timer));
    });
  }
}
