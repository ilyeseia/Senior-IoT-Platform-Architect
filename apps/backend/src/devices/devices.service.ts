import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { OnEvent } from "@nestjs/event-emitter";
import { Repository } from "typeorm";
import { Device } from "./device.entity";
import type { DeviceStatusEvent } from "../mqtt/mqtt.events";

@Injectable()
export class DevicesService {
  private readonly logger = new Logger(DevicesService.name);

  constructor(@InjectRepository(Device) private readonly repo: Repository<Device>) {}

  findAll(): Promise<Device[]> {
    return this.repo.find({ order: { firstSeenAt: "ASC" } });
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
}
