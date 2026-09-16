import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { OnEvent } from "@nestjs/event-emitter";
import { In, Not, Repository } from "typeorm";
import { capabilityGroupIds } from "@esp-claw/protocol";
import { Device } from "./device.entity";
import { DeviceCapability } from "./device-capability.entity";
import { LocalApiClient } from "../esp-claw/local-api-client";
import type { DeviceStatusEvent } from "../mqtt/mqtt.events";

@Injectable()
export class DevicesService {
  private readonly logger = new Logger(DevicesService.name);

  constructor(
    @InjectRepository(Device) private readonly repo: Repository<Device>,
    @InjectRepository(DeviceCapability) private readonly capRepo: Repository<DeviceCapability>,
    private readonly localApi: LocalApiClient,
  ) {}

  findAll(): Promise<Device[]> {
    return this.repo.find({ order: { firstSeenAt: "ASC" } });
  }

  /** Devices currently marked online — used by TelemetryPollerService (Data Plane §13) to avoid dispatching commands to devices known to be unreachable. */
  findOnline(): Promise<Device[]> {
    return this.repo.find({ where: { online: true }, order: { id: "ASC" } });
  }

  /** Whether a device has reported the given capability group (Phase 6). Used to skip polling a capability a device doesn't have, instead of generating a failed command every cycle. */
  async hasCapabilityGroup(deviceId: string, groupId: string): Promise<boolean> {
    const count = await this.capRepo.count({ where: { deviceId, groupId } });
    return count > 0;
  }

  findOne(id: string): Promise<Device | null> {
    return this.repo.findOne({ where: { id } });
  }

  /**
   * Auto-registration (PHASE1-ANALYSIS.md §E.2): the first time a device_id
   * is seen — from a real MQTT status message today — a row is created if
   * one doesn't already exist. Called directly by upsertPresence(); exposed
   * separately too since Phase 6's capability-catalog introspection will
   * want to call this on first contact as well, without duplicating the
   * "does this device already exist" logic.
   */
  async findOrCreate(id: string, baseTopic: string): Promise<Device> {
    const existing = await this.repo.findOne({ where: { id } });
    if (existing) {
      return existing;
    }
    this.logger.log(`Auto-registering new device ${id} (baseTopic=${baseTopic})`);
    return this.repo.save(this.repo.create({ id, baseTopic, online: false, lastSeenAt: null }));
  }

  private async upsertPresence(id: string, baseTopic: string, online: boolean): Promise<void> {
    await this.findOrCreate(id, baseTopic);
    await this.repo.update({ id }, { online, lastSeenAt: new Date() });
  }

  /**
   * Listens for the event MqttService emits on every real status message
   * (PHASE1-ANALYSIS.md §C) — decoupled via EventEmitter2 rather than
   * MqttModule importing DevicesModule directly, so future listeners
   * (Alerts on offline transitions, Automation, ...) can subscribe to the
   * same event without MqttService needing to know they exist.
   */
  @OnEvent("device.status")
  async handleDeviceStatus(event: DeviceStatusEvent): Promise<void> {
    await this.upsertPresence(event.deviceId, event.baseTopic, event.online);
  }

  listCapabilities(id: string): Promise<DeviceCapability[]> {
    return this.capRepo.find({ where: { deviceId: id }, order: { groupId: "ASC" } });
  }

  /**
   * Phase 6 introspection (PHASE1-ANALYSIS.md §K): pull the device's real
   * capability catalog from its local `GET /api/capabilities` over the tailnet
   * and persist the groups. `baseUrl` (a device tailnet host/URL) overrides and
   * updates the stored `localApiBaseUrl`. Existing rows are kept (preserving
   * firstSeenAt), newly-absent groups are removed. Ongoing traffic stays on
   * MQTT — this is a one-shot discovery pull, never a live data path.
   */
  async refreshCapabilities(id: string, baseUrl?: string): Promise<DeviceCapability[]> {
    const device = await this.repo.findOne({ where: { id } });
    if (!device) {
      throw new NotFoundException(`Device ${id} not found`);
    }
    const url = (baseUrl ?? device.localApiBaseUrl ?? "").trim();
    if (!url) {
      throw new BadRequestException(
        "No local API base URL known for this device — pass { baseUrl } or set it first",
      );
    }

    const catalog = await this.localApi.fetchCapabilities(url);
    const groupIds = capabilityGroupIds(catalog);
    this.logger.log(`Device ${id}: discovered ${groupIds.length} capability group(s) via ${url}`);

    await this.capRepo.manager.transaction(async (tx) => {
      if (catalog.items.length > 0) {
        await tx.upsert(
          DeviceCapability,
          catalog.items.map((g) => ({
            deviceId: id,
            groupId: g.group_id,
            displayName: g.display_name,
            defaultLlmVisible: g.default_llm_visible,
          })),
          ["deviceId", "groupId"],
        );
        await tx.delete(DeviceCapability, { deviceId: id, groupId: Not(In(groupIds)) });
      } else {
        await tx.delete(DeviceCapability, { deviceId: id });
      }
      await tx.update(Device, { id }, { localApiBaseUrl: url, capabilitiesRefreshedAt: new Date() });
    });

    return this.listCapabilities(id);
  }
}
