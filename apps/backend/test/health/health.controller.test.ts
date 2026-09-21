import { describe, expect, it } from "vitest";
import { ServiceUnavailableException } from "@nestjs/common";
import type { DataSource } from "typeorm";
import { HealthController } from "../../src/health/health.controller";
import type { MqttService } from "../../src/mqtt";

const ds = (query: () => Promise<unknown>) => ({ query }) as unknown as DataSource;
const mqtt = (configured: boolean, connected: boolean) =>
  ({ isConfigured: () => configured, isConnected: () => connected }) as unknown as MqttService;

describe("HealthController", () => {
  it("liveness never touches a dependency", () => {
    const controller = new HealthController(ds(() => Promise.reject(new Error("db down"))), mqtt(true, false));
    expect(controller.check()).toMatchObject({ status: "ok" });
    expect(controller.live()).toMatchObject({ status: "ok" });
  });

  it("is ready when the database answers and MQTT is connected", async () => {
    const r = await new HealthController(ds(async () => [{ "?column?": 1 }]), mqtt(true, true)).ready();
    expect(r).toMatchObject({ status: "ok", checks: { database: "up", mqtt: "up" } });
  });

  it("reports MQTT as disabled when it is not configured, and stays ok", async () => {
    const r = await new HealthController(ds(async () => []), mqtt(false, false)).ready();
    expect(r).toMatchObject({ status: "ok", checks: { database: "up", mqtt: "disabled" } });
  });

  it("stays HTTP 200 but reports degraded when only MQTT is down", async () => {
    const r = await new HealthController(ds(async () => []), mqtt(true, false)).ready();
    expect(r).toMatchObject({ status: "degraded", checks: { database: "up", mqtt: "down" } });
  });

  it("fails readiness (503) when the database is down, carrying the per-check result", async () => {
    const controller = new HealthController(ds(() => Promise.reject(new Error("connection refused"))), mqtt(true, true));
    const err = await controller.ready().catch((e) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect((err as ServiceUnavailableException).getResponse()).toMatchObject({
      message: "Service not ready",
      details: { status: "degraded", checks: { database: "down", mqtt: "up" } },
    });
  });

  it("treats a database that never answers as down (timeout)", async () => {
    const controller = new HealthController(ds(() => new Promise(() => undefined)), mqtt(false, false));
    const err = await controller.ready().catch((e) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
  }, 6000);
});
