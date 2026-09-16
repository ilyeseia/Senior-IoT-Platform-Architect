import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { CommandsService } from "../commands/commands.service";
import { DevicesService } from "../devices/devices.service";
import { TelemetryService, extractSamples } from "./telemetry.service";
import { TwinService } from "../twin/twin.service";
import type { Env } from "../config/env.validation";

const DEFAULT_POLL_INTERVAL_MS = 60_000;
const POLL_COMMAND_TIMEOUT_MS = 8_000;

/**
 * Data Plane telemetry, Option B (ARCHITECTURE-EVOLUTION.md §13, decision
 * locked): dispatches a fixed set of already-real capability calls through
 * the EXISTING command/response path (CommandsService — same mechanism a
 * human operator uses via POST /devices/:id/commands) on an interval, and
 * hands each result to TelemetryService for extraction/storage. No new
 * device-facing mechanism — this is a platform-side scheduler over what
 * already works.
 *
 * Each target capability's owning group must be present in the device's
 * discovered capabilities (Phase 6, device_capabilities) or it's skipped —
 * avoids generating a failed command every cycle for a device that simply
 * doesn't have that capability (fleet is heterogeneous by design, PHASE1
 * §item... and the original brief's item 4).
 *
 * All four capability response shapes below were authored by me earlier this
 * session in esp-claw-2's cap_mqtt/cap_vpn/cap_netcfg/cap_ota — not assumed.
 */
const POLL_TARGETS: { capability: string; requiredGroup: string }[] = [
  { capability: "mqtt_status", requiredGroup: "cap_mqtt" },
  { capability: "vpn_status", requiredGroup: "cap_vpn" },
  { capability: "network_status", requiredGroup: "cap_netcfg" },
  { capability: "ota_status", requiredGroup: "cap_ota" },
];

@Injectable()
export class TelemetryPollerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelemetryPollerService.name);
  private timer: NodeJS.Timeout | null = null;
  private polling = false;

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly devices: DevicesService,
    private readonly commands: CommandsService,
    private readonly telemetry: TelemetryService,
    private readonly twin: TwinService,
  ) {}

  onModuleInit(): void {
    const intervalMs = this.config.get("TELEMETRY_POLL_INTERVAL_MS", { infer: true }) ?? DEFAULT_POLL_INTERVAL_MS;
    this.timer = setInterval(() => void this.pollOnce(), intervalMs);
    this.logger.log(`Telemetry poller started (every ${intervalMs}ms)`);
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Exposed for tests and for a future manual "poll now" trigger — not wired to an endpoint yet (no need identified). */
  async pollOnce(): Promise<void> {
    if (this.polling) {
      this.logger.warn("Skipping poll tick — previous cycle still running");
      return;
    }
    this.polling = true;
    try {
      const online = await this.devices.findOnline();
      for (const device of online) {
        for (const target of POLL_TARGETS) {
          const hasGroup = await this.devices.hasCapabilityGroup(device.id, target.requiredGroup);
          if (!hasGroup) {
            continue;
          }
          await this.pollOne(device.id, target.capability);
        }
      }
    } finally {
      this.polling = false;
    }
  }

  private async pollOne(deviceId: string, capability: string): Promise<void> {
    try {
      const { result } = await this.commands.dispatch(deviceId, {
        name: capability,
        timeoutMs: POLL_COMMAND_TIMEOUT_MS,
      });
      if (!result.ok) {
        this.logger.debug(`${deviceId}: ${capability} -> not ok, skipping (${result.result ?? ""})`);
        return;
      }
      const count = await this.telemetry.recordCapabilityResult(deviceId, capability, result.result);
      // Digital Twin (ARCHITECTURE-EVOLUTION.md §18): the same extracted
      // scalar fields become the twin's `reported` state — one extraction
      // source, two consumers (time-series + latest-value snapshot).
      await this.twin.mergeReported(deviceId, extractSamples(result.result));
      this.logger.debug(`${deviceId}: ${capability} -> ${count} sample(s)`);
    } catch (err) {
      this.logger.warn(`${deviceId}: ${capability} poll failed: ${(err as Error).message}`);
    }
  }
}
