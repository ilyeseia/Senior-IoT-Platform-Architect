import { Controller, Get, ServiceUnavailableException } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { Public } from "../identity";
import { MqttService } from "../mqtt";

const DB_CHECK_TIMEOUT_MS = 2_000;

interface LivenessResponse {
  status: "ok";
  uptimeSeconds: number;
  timestamp: string;
}

type CheckState = "up" | "down" | "disabled";

interface ReadinessResponse {
  status: "ok" | "degraded";
  checks: { database: CheckState; mqtt: CheckState };
  timestamp: string;
}

/**
 * Unversioned by design and public: orchestrators and load balancers must reach these without a
 * token.
 *  - `/health` and `/health/live`: the process is up and the event loop answers. Never touches a
 *    dependency, so a database outage cannot make an orchestrator restart a healthy process.
 *  - `/health/ready`: can this instance do useful work? The database is required (503 without it).
 *    The MQTT broker is reported but does not fail readiness: reads, the twin and the audit log
 *    work without it, and the client reconnects on its own — pulling the instance out of rotation
 *    would not help.
 */
@Controller("health")
export class HealthController {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly mqtt: MqttService,
  ) {}

  @Public()
  @Get()
  check(): LivenessResponse {
    return this.liveness();
  }

  @Public()
  @Get("live")
  live(): LivenessResponse {
    return this.liveness();
  }

  @Public()
  @Get("ready")
  async ready(): Promise<ReadinessResponse> {
    const database = await this.checkDatabase();
    const mqtt: CheckState = !this.mqtt.isConfigured() ? "disabled" : this.mqtt.isConnected() ? "up" : "down";
    const body: ReadinessResponse = {
      status: database === "up" && mqtt !== "down" ? "ok" : "degraded",
      checks: { database, mqtt },
      timestamp: new Date().toISOString(),
    };
    if (database !== "up") {
      // The error envelope carries the per-check result as `details`, so the caller sees what failed.
      throw new ServiceUnavailableException({ message: "Service not ready", details: body });
    }
    return body;
  }

  private liveness(): LivenessResponse {
    return { status: "ok", uptimeSeconds: Math.round(process.uptime()), timestamp: new Date().toISOString() };
  }

  private async checkDatabase(): Promise<CheckState> {
    try {
      await Promise.race([
        this.dataSource.query("SELECT 1"),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), DB_CHECK_TIMEOUT_MS).unref()),
      ]);
      return "up";
    } catch {
      return "down";
    }
  }
}
