import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { DeviceShadow } from "./device-shadow.entity";
import type { ExtractedSample } from "../telemetry/telemetry.service";

export interface ShadowView {
  deviceId: string;
  desired: Record<string, unknown>;
  reported: Record<string, unknown>;
  desiredVersion: number;
  reportedVersion: number;
  drift: string[];
  inSync: boolean;
  updatedAt: Date | null;
}

const EMPTY_SHADOW: Omit<ShadowView, "deviceId" | "drift" | "inSync"> = {
  desired: {},
  reported: {},
  desiredVersion: 0,
  reportedVersion: 0,
  updatedAt: null,
};

@Injectable()
export class TwinService {
  constructor(@InjectRepository(DeviceShadow) private readonly repo: Repository<DeviceShadow>) {}

  /** Never 404s — a device with no shadow row yet just has an empty, in-sync twin. */
  async getShadow(deviceId: string): Promise<ShadowView> {
    const row = await this.repo.findOne({ where: { deviceId } });
    const base = row ?? { deviceId, ...EMPTY_SHADOW };
    return { ...base, ...computeDrift(base.desired, base.reported) };
  }

  /**
   * Operator-authored intent. Every call bumps `desiredVersion`, even if the
   * values are unchanged — it's a record of "an operator asked for this,
   * at this time," not just a value cache (matches AWS IoT Shadow's own
   * versioning convention: version tracks accepted updates, not value diffs).
   *
   * Deliberately does NOT attempt to push this to the device — see
   * DIGITAL-TWIN.md: reconciliation is separate, later work, gated on
   * cap_platform for any field that maps to a RESTRICTED capability.
   */
  async setDesired(deviceId: string, patch: Record<string, unknown>): Promise<ShadowView> {
    const row = await this.findOrCreate(deviceId);
    row.desired = { ...row.desired, ...patch };
    row.desiredVersion += 1;
    await this.repo.save(row);
    return { ...row, ...computeDrift(row.desired, row.reported) };
  }

  /**
   * Called by TelemetryPollerService right after it records a poll result
   * (twin.module.ts is imported by telemetry.module.ts for this) — reuses
   * the exact same extracted scalar fields telemetry stores, as the twin's
   * `reported` state, per §18's "reported comes from capability-call
   * results" design. A no-op if there's nothing to merge (empty poll).
   */
  async mergeReported(deviceId: string, samples: ExtractedSample[]): Promise<void> {
    if (samples.length === 0) {
      return;
    }
    const row = await this.findOrCreate(deviceId);
    for (const sample of samples) {
      row.reported[sample.metric] = sample.valueNumeric ?? sample.valueBool;
    }
    row.reportedVersion += 1;
    await this.repo.save(row);
  }

  private async findOrCreate(deviceId: string): Promise<DeviceShadow> {
    const existing = await this.repo.findOne({ where: { deviceId } });
    if (existing) {
      return existing;
    }
    // Explicit zero versions rather than relying on the column DEFAULT: a
    // freshly `create()`d entity instance doesn't reflect DB-side defaults
    // until re-read, so `row.desiredVersion += 1` right after would be NaN.
    return this.repo.save(
      this.repo.create({ deviceId, desired: {}, reported: {}, desiredVersion: 0, reportedVersion: 0 }),
    );
  }
}

function computeDrift(
  desired: Record<string, unknown>,
  reported: Record<string, unknown>,
): { drift: string[]; inSync: boolean } {
  const drift = Object.keys(desired).filter((key) => desired[key] !== reported[key]);
  return { drift, inSync: drift.length === 0 };
}
