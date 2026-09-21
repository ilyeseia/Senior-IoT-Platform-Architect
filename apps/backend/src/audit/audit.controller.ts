import { Controller, Get, Query } from "@nestjs/common";
import { z } from "zod";
import { parseBody } from "../common/validation/parse-body";
import { EventLogService } from "./event-log.service";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const querySchema = z
  .object({
    device_id: z.string().min(1).max(32).optional(),
    type: z.string().min(1).max(96).optional(),
    correlation_id: z.string().min(1).max(128).optional(),
    before_seq: z.string().regex(/^\d{1,19}$/, "before_seq must be a positive integer").optional(),
    limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  })
  .strict();

/** Read-only view of the append-only event history. There is deliberately no write endpoint. */
@Controller("audit")
export class AuditController {
  constructor(private readonly log: EventLogService) {}

  @Get("events")
  async events(@Query() rawQuery: unknown) {
    const q = parseBody(querySchema, rawQuery);
    const page = await this.log.find({
      deviceId: q.device_id,
      eventType: q.type,
      correlationId: q.correlation_id,
      beforeSeq: q.before_seq,
      limit: q.limit,
    });
    return {
      items: page.items.map((r) => ({
        seq: r.seq,
        event_id: r.eventId,
        event_type: r.eventType,
        schema_version: r.schemaVersion,
        timestamp: r.occurredAt,
        recorded_at: r.recordedAt,
        device_id: r.deviceId,
        source: r.source,
        correlation_id: r.correlationId,
        causation_id: r.causationId,
        trace_id: r.traceId,
        payload: r.payload,
      })),
      next_cursor: page.nextCursor,
    };
  }
}
