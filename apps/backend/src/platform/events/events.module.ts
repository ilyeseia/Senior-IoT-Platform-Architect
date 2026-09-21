import { Global, Module } from "@nestjs/common";
import { EVENT_BUS } from "./event-bus";
import { InProcessEventBus } from "./in-process-event-bus";

/**
 * Provides the EventBus port application-wide (@Global: every module publishes and subscribes
 * through the same bus, and none of them should import it explicitly). Swapping the adapter is a
 * one-line change here.
 */
@Global()
@Module({
  providers: [InProcessEventBus, { provide: EVENT_BUS, useExisting: InProcessEventBus }],
  exports: [EVENT_BUS, InProcessEventBus],
})
export class EventsModule {}
