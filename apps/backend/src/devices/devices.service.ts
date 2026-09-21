import { BadRequestException, Inject, Injectable, Logger, NotFoundException, OnModuleInit } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { In, Not, Repository } from "typeorm";
import { capabilityGroupIds } from "@esp-claw/protocol";
import { Device } from "./device.entity";
import { DeviceCapability } from "./device-capability.entity";
import { LocalApiClient } from "../esp-claw";
import { LocalTargetError } from "../esp-claw";
import { EVENT_BUS, EventTypes, createEvent } from "../platform";
import type {
  DeviceOnlinePayload,
  DeviceRegisteredPayload,
  DomainEvent,
  EventBus,
  PresenceReportedPayload,
} from "../platform";

@Injectable()
export class DevicesService implements OnModuleInit {
  private readonly logger = new Logger(DevicesService.name);

  constructor(
    @InjectRepository(Device) private readonly repo: Repository<Device>,
    @InjectRepository(DeviceCapability) private readonly capRepo: Repository<DeviceCapability>,
    private readonly localApi: LocalApiClient,
    @Inject(EVENT_BUS) private readonly bus: EventBus,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe(EventTypes.DEVICE_PRESENCE_REPORTED, (event) => this.handlePresenceReported(event), {
      name: "devices.presence",
    });
  }

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
    const created = await this.repo.save(this.repo.create({ id, baseTopic, online: false, lastSeenAt: null }));
    this.bus.publish(
      createEvent<DeviceRegisteredPayload>({
        type: EventTypes.DEVICE_REGISTERED,
        source: "module:devices",
        deviceId: id,
        payload: { baseTopic },
      }),
    );
    return created;
  }

  /**
   * Turns a raw presence observation from the gateway into registry state and lifecycle events
   * (`device.registered` on first contact, `device.online` / `device.offline` on a real change).
   * The bus delivers one device's observations in order, so a fast online→offline flap cannot be
   * applied backwards (audit B6).
   */
  async handlePresenceReported(event: DomainEvent): Promise<void> {
    const { baseTopic, online } = event.payload as PresenceReportedPayload;
    const id = event.device_id;
    if (!id) {
      return;
    }
    const before = await this.repo.findOne({ where: { id } });
    await this.findOrCreate(id, baseTopic);
    await this.repo.update({ id }, { online, lastSeenAt: new Date(event.timestamp) });

    const wasOnline = before?.online ?? false;
    if (wasOnline !== online) {
      this.bus.publish(
        createEvent<DeviceOnlinePayload>({
          type: online ? EventTypes.DEVICE_ONLINE : EventTypes.DEVICE_OFFLINE,
          source: "module:devices",
          deviceId: id,
          causationId: event.event_id,
          correlationId: event.correlation_id,
          payload: { previous: wasOnline },
        }),
      );
    }
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
    const requested = (baseUrl ?? device.localApiBaseUrl ?? "").trim();
    if (!requested) {
      throw new BadRequestException(
        "No local API base URL known for this device — pass { baseUrl } or set it first",
      );
    }
    let url: string;
    try {
      // SSRF guard (audit B3): never let an API caller point the backend at an arbitrary host.
      url = this.localApi.validateBaseUrl(requested);
    } catch (err) {
      if (err instanceof LocalTargetError) {
        throw new BadRequestException(`Invalid device URL: ${err.message}`);
      }
      throw err;
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
