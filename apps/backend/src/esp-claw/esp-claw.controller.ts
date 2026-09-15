import { BadRequestException, Controller, Get, Query } from "@nestjs/common";
import { TopicService } from "./topic.service";

/**
 * Debug/verification endpoint for Phase 3 — lets us exercise the real
 * ESP-Claw topic-building logic over HTTP without a broker connection
 * (that's Phase 4). Not a device-facing API.
 */
@Controller("esp-claw")
export class EspClawController {
  constructor(private readonly topics: TopicService) {}

  @Get("topics")
  getTopics(@Query("deviceId") deviceId?: string, @Query("baseTopic") baseTopic?: string) {
    if (!deviceId) {
      throw new BadRequestException("deviceId query param is required");
    }
    return baseTopic ? this.topics.topicsFor(deviceId, baseTopic) : this.topics.topicsFor(deviceId);
  }
}
