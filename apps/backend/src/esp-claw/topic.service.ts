import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { buildTopic, deviceTopics, DeviceTopics, Leaf, parseTopic } from "@esp-claw/protocol";
import type { Env } from "../config/env.validation";

/**
 * The single place backend code goes to build or parse an ESP-Claw MQTT
 * topic. No other module should import "@esp-claw/protocol" directly or
 * concatenate a topic string by hand — that's the whole point of the
 * Integration/Adapter Layer (PHASE1-ANALYSIS.md §B,
 * PHASE2-REPOSITORY-STRUCTURE.md "esp-claw/").
 */
@Injectable()
export class TopicService {
  private readonly defaultBaseTopic: string;

  constructor(private readonly config: ConfigService<Env, true>) {
    this.defaultBaseTopic = this.config.get("MQTT_BASE_TOPIC_PREFIX", { infer: true });
  }

  build(deviceId: string, leaf: Leaf, baseTopic = this.defaultBaseTopic): string {
    return buildTopic(baseTopic, deviceId, leaf);
  }

  topicsFor(deviceId: string, baseTopic = this.defaultBaseTopic): DeviceTopics {
    return deviceTopics(baseTopic, deviceId);
  }

  parse(topic: string) {
    return parseTopic(topic);
  }
}
