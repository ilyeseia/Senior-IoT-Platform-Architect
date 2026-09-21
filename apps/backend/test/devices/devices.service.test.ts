import { describe, expect, it, vi } from "vitest";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import type { Repository } from "typeorm";
import { DevicesService } from "../../src/devices/devices.service";
import { LocalApiClient } from "../../src/esp-claw/local-api-client";
import type { Device } from "../../src/devices/device.entity";
import type { DeviceCapability } from "../../src/devices/device-capability.entity";
import { RecordingEventBus } from "../helpers/recording-bus";

function makeService(device: Partial<Device> | null) {
  const repo = { findOne: vi.fn(async () => device) };
  const capRepo = { manager: { transaction: vi.fn() }, find: vi.fn(async () => []) };
  const localApi = new LocalApiClient();
  const fetchCapabilities = vi.spyOn(localApi, "fetchCapabilities");
  const service = new DevicesService(
    repo as unknown as Repository<Device>,
    capRepo as unknown as Repository<DeviceCapability>,
    localApi,
    new RecordingEventBus(),
  );
  return { service, fetchCapabilities };
}

describe("DevicesService.refreshCapabilities SSRF guard (audit B3)", () => {
  it("rejects a public/metadata host with 400 before any request is made", async () => {
    const { service, fetchCapabilities } = makeService({ id: "d1" });
    await expect(service.refreshCapabilities("d1", "http://169.254.169.254")).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(fetchCapabilities).not.toHaveBeenCalled();
  });

  it("also validates a previously stored URL", async () => {
    const { service, fetchCapabilities } = makeService({ id: "d1", localApiBaseUrl: "http://evil.example.com" });
    await expect(service.refreshCapabilities("d1")).rejects.toBeInstanceOf(BadRequestException);
    expect(fetchCapabilities).not.toHaveBeenCalled();
  });

  it("404s for an unknown device", async () => {
    const { service } = makeService(null);
    await expect(service.refreshCapabilities("nope", "10.0.0.1")).rejects.toBeInstanceOf(NotFoundException);
  });
});
