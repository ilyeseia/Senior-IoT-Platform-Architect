import type { DomainEvent, EventBus, EventHandler, SubscribeOptions } from "../../src/platform";

/** Test double for the EventBus port: records what was published; subscriptions are kept so tests can invoke them. */
export class RecordingEventBus implements EventBus {
  readonly events: DomainEvent[] = [];
  readonly subscriptions: { pattern: string; handler: EventHandler; options: SubscribeOptions }[] = [];

  publish(event: DomainEvent): void {
    this.events.push(event);
  }

  subscribe(pattern: string, handler: EventHandler, options: SubscribeOptions): () => void {
    const sub = { pattern, handler, options };
    this.subscriptions.push(sub);
    return () => void this.subscriptions.splice(this.subscriptions.indexOf(sub), 1);
  }

  async drain(): Promise<void> {}

  ofType(type: string): DomainEvent[] {
    return this.events.filter((e) => e.event_type === type);
  }
}
