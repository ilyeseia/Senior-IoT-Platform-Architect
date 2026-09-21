import { Inject, Injectable, OnModuleInit } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { EVENT_BUS, isAuditedEventType } from "../platform";
import type { DomainEvent, EventBus } from "../platform";
import { EventLogRecord } from "./event-log.entity";

export interface EventLogQuery {
  deviceId?: string;
  eventType?: string;
  correlationId?: string;
  /** Return only records older than this `seq` (cursor for the next page). */
  beforeSeq?: string;
  limit: number;
}

export interface EventLogPage {
  items: EventLogRecord[];
  /** Pass as `before_seq` to get the next (older) page; null when there is none. */
  nextCursor: string | null;
}

/**
 * Records the auditable subset of platform events (`isAuditedEventType`) into the append-only
 * `event_log`. It is an ordinary event consumer: it depends only on the bus port and never on the
 * modules that produce events.
 *
 * Recording is idempotent (`ON CONFLICT (event_id) DO NOTHING`), so at-least-once delivery and the
 * retries below cannot create duplicates. It retries a few times because losing an audit record to
 * a transient database error is worse than a short delay.
 */
@Injectable()
export class EventLogService implements OnModuleInit {
  constructor(
    @InjectRepository(EventLogRecord) private readonly repo: Repository<EventLogRecord>,
    @Inject(EVENT_BUS) private readonly bus: EventBus,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe("**", (event) => this.recordIfAudited(event), {
      name: "audit.event-log",
      retries: 3,
      backoffMs: 200,
    });
  }

  async recordIfAudited(event: DomainEvent): Promise<void> {
    if (!isAuditedEventType(event.event_type)) {
      return;
    }
    await this.repo
      .createQueryBuilder()
      .insert()
      .into(EventLogRecord)
      .values({
        eventId: event.event_id,
        eventType: event.event_type,
        schemaVersion: event.schema_version,
        occurredAt: new Date(event.timestamp),
        deviceId: event.device_id,
        organizationId: event.organization_id,
        source: event.source,
        correlationId: event.correlation_id,
        causationId: event.causation_id,
        traceId: event.trace_id,
        spanId: event.span_id,
        // jsonb: the driver serialises it; the cast only bridges TypeORM's deep-partial insert typing.
        payload: (event.payload ?? {}) as never,
      })
      .orIgnore()
      .execute();
  }

  async find(query: EventLogQuery): Promise<EventLogPage> {
    const qb = this.repo.createQueryBuilder("e").orderBy("e.seq", "DESC").take(query.limit + 1);
    if (query.deviceId) {
      qb.andWhere("e.device_id = :deviceId", { deviceId: query.deviceId });
    }
    if (query.eventType) {
      qb.andWhere("e.event_type = :eventType", { eventType: query.eventType });
    }
    if (query.correlationId) {
      qb.andWhere("e.correlation_id = :correlationId", { correlationId: query.correlationId });
    }
    if (query.beforeSeq) {
      qb.andWhere("e.seq < :beforeSeq", { beforeSeq: query.beforeSeq });
    }
    const rows = await qb.getMany();
    const hasMore = rows.length > query.limit;
    const items = hasMore ? rows.slice(0, query.limit) : rows;
    return { items, nextCursor: hasMore ? items[items.length - 1].seq : null };
  }
}
