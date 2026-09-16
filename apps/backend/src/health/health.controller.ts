import { Controller, Get } from "@nestjs/common";
import { Public } from "../identity/public.decorator";

interface HealthResponse {
  status: "ok";
  uptimeSeconds: number;
  timestamp: string;
}

@Controller("health")
export class HealthController {
  @Public()
  @Get()
  check(): HealthResponse {
    return {
      status: "ok",
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  }
}
