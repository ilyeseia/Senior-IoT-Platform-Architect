import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Between, LessThanOrEqual, MoreThanOrEqual, Repository } from "typeorm";
import { TelemetrySample } from "./telemetry-sample.entity";

export interface ExtractedSample {
  metric: string;
  valueNumeric: number | null;
  valueBool: boolean | null;
}

/**
 * Pure extraction logic (Option B, ARCHITECTURE-EVOLUTION.md §13): a
 * capability's `result` field is a plain string (ResponseEnvelopeSchema),
 * which — for the capabilities this poller targets (mqtt_status, vpn_status,
 * network_status, ota_status) — is itself JSON text produced by the real
 * device firmware's own `cJSON_PrintUnformatted` output (verified: I wrote
 * all four of those capabilities' response bodies in esp-claw-2 this
 * session). This walks whatever top-level scalar fields exist rather than
 * hardcoding field names per capability, so it keeps working if a
 * capability's fields change or a new capability is added to the poll list
 * without a code change here.
 *
 * Deliberately narrow: only number/boolean top-level fields become telemetry
 * samples. Strings/objects/arrays/null are skipped — free text isn't a
 * time-series metric (see §13's own scope note: broader value types are
 * explicitly deferred, not silently dropped by accident).
 */
export function extractSamples(resultJson: string | null | undefined): ExtractedSample[] {
  if (!resultJson) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(resultJson);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return [];
  }

  const samples: ExtractedSample[] = [];
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === "number" && Number.isFinite(value)) {
      samples.push({ metric: key, valueNumeric: value, valueBool: null });
    } else if (typeof value === "boolean") {
      samples.push({ metric: key, valueNumeric: null, valueBool: value });
    }
  }
  return samples;
}

export interface TelemetryQuery {
  metric?: string;
  from?: Date;
  to?: Date;
  limit?: number;
}

const DEFAULT_QUERY_LIMIT = 500;
const MAX_QUERY_LIMIT = 5000;

@Injectable()
export class TelemetryService {
  constructor(@InjectRepository(TelemetrySample) private readonly repo: Repository<TelemetrySample>) {}

  /** Persists every scalar field extracted from one capability result, all sharing one recordedAt (one poll = one snapshot). */
  async recordCapabilityResult(deviceId: string, source: string, resultJson: string | null | undefined): Promise<number> {
    const samples = extractSamples(resultJson);
    if (samples.length === 0) {
      return 0;
    }
    const recordedAt = new Date();
    await this.repo.insert(
      samples.map((s) => ({
        deviceId,
        metric: s.metric,
        recordedAt,
        valueNumeric: s.valueNumeric,
        valueBool: s.valueBool,
        source,
      })),
    );
    return samples.length;
  }

  findForDevice(deviceId: string, query: TelemetryQuery = {}): Promise<TelemetrySample[]> {
    const limit = Math.min(query.limit ?? DEFAULT_QUERY_LIMIT, MAX_QUERY_LIMIT);
    return this.repo.find({
      where: this.buildWhere(deviceId, query),
      order: { recordedAt: "DESC" },
      take: limit,
    });
  }

  private buildWhere(deviceId: string, query: TelemetryQuery): Record<string, unknown> {
    const where: Record<string, unknown> = { deviceId };
    if (query.metric) {
      where.metric = query.metric;
    }
    if (query.from && query.to) {
      where.recordedAt = Between(query.from, query.to);
    } else if (query.from) {
      where.recordedAt = MoreThanOrEqual(query.from);
    } else if (query.to) {
      where.recordedAt = LessThanOrEqual(query.to);
    }
    return where;
  }
}
