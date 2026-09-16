import { BadRequestException, Controller, Get, Param, Query } from "@nestjs/common";
import { TelemetryService } from "./telemetry.service";

/** Read side of Data Plane telemetry (§13). Write side is TelemetryPollerService — no ingest endpoint exists yet (nothing pushes telemetry in from outside the poller today). */
@Controller("devices/:id/telemetry")
export class TelemetryController {
  constructor(private readonly telemetry: TelemetryService) {}

  @Get()
  findForDevice(
    @Param("id") id: string,
    @Query("metric") metric?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("limit") limit?: string,
  ) {
    const parsedFrom = this.parseDate(from, "from");
    const parsedTo = this.parseDate(to, "to");
    const parsedLimit = limit !== undefined ? Number(limit) : undefined;
    if (parsedLimit !== undefined && (!Number.isFinite(parsedLimit) || parsedLimit <= 0)) {
      throw new BadRequestException("limit must be a positive number");
    }
    return this.telemetry.findForDevice(id, { metric, from: parsedFrom, to: parsedTo, limit: parsedLimit });
  }

  private parseDate(value: string | undefined, field: string): Date | undefined {
    if (value === undefined) {
      return undefined;
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException(`${field} must be a valid ISO date`);
    }
    return date;
  }
}
