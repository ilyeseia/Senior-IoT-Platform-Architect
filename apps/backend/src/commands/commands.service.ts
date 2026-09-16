import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { randomUUID } from "crypto";
import { Repository } from "typeorm";
import { ResponseEnvelope } from "@esp-claw/protocol";
import { MqttService } from "../mqtt/mqtt.service";
import { DevicesService } from "../devices/devices.service";
import { Command, CommandStatus } from "./command.entity";
import { CommandResult } from "./command-result.entity";

export interface DispatchInput {
  name: string;
  input?: Record<string, unknown>;
  baseTopic?: string;
  timeoutMs?: number;
}

export interface DispatchOutcome {
  command: Command;
  result: CommandResult;
}

const DEFAULT_TIMEOUT_MS = 15000;

/**
 * The real "Command Service" from the architecture (PHASE1-ANALYSIS.md §B):
 * the only thing that both writes command history AND calls MqttService to
 * actually publish. Phase 4 built the live MQTT round-trip; this phase adds
 * the DB-backed history/status-classification on top of it.
 */
@Injectable()
export class CommandsService {
  private readonly logger = new Logger(CommandsService.name);

  constructor(
    @InjectRepository(Command) private readonly commands: Repository<Command>,
    @InjectRepository(CommandResult) private readonly results: Repository<CommandResult>,
    private readonly mqtt: MqttService,
    private readonly devices: DevicesService,
  ) {}

  async dispatch(deviceId: string, input: DispatchInput): Promise<DispatchOutcome> {
    // Ensure the device has a registry row even if it's never sent a status
    // message yet (e.g. a freshly provisioned device being commanded before
    // its first MQTT connection) — baseTopic defaults match TopicService's
    // own default when none is given.
    await this.devices.findOrCreate(deviceId, input.baseTopic ?? "espclaw");

    const id = randomUUID();
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const command = await this.commands.save(
      this.commands.create({
        id,
        deviceId,
        name: input.name,
        input: input.input ?? {},
        status: "pending",
        timeoutMs,
      }),
    );

    let response: ResponseEnvelope;
    try {
      response = await this.mqtt.sendCommand(
        deviceId,
        { name: input.name, input: input.input },
        { baseTopic: input.baseTopic, timeoutMs },
      );
      // sendCommand() generates its own wire "id" internally (it doesn't
      // accept ours) — see the note in resolveOutcome() for why that's fine.
    } catch (err) {
      return this.resolveOutcome(command, {
        id,
        ok: false,
        result: (err as Error).message,
      });
    }

    return this.resolveOutcome(command, response);
  }

  findAllForDevice(deviceId: string): Promise<Command[]> {
    return this.commands.find({ where: { deviceId }, order: { createdAt: "DESC" } });
  }

  private async resolveOutcome(command: Command, response: ResponseEnvelope): Promise<DispatchOutcome> {
    const status = this.classify(response);
    command.status = status;
    command.resolvedAt = new Date();
    await this.commands.save(command);

    const result = await this.results.save(
      this.results.create({
        commandId: command.id,
        ok: response.ok,
        result: response.result ?? null,
        receivedAt: new Date(),
      }),
    );

    this.logger.log(`Command ${command.id} (${command.name} -> ${command.deviceId}) resolved: ${status}`);
    return { command, result };
  }

  /**
   * "rejected" vs "failed" (PHASE1-ANALYSIS.md §C): the real cap_mqtt bridge
   * denies a RESTRICTED/ROOT_AGENT_ONLY capability with
   * ok:false + a result string starting "Denied agent cap call..." — verified
   * live this session (this session's own MQTT-bridge security-bypass
   * finding and fix). Everything else that fails is a real device-side error.
   */
  private classify(response: ResponseEnvelope): CommandStatus {
    if (response.ok) {
      return "succeeded";
    }
    if (response.result?.startsWith("Denied agent cap call")) {
      return "rejected";
    }
    if (response.result?.includes("timed out")) {
      return "timed_out";
    }
    return "failed";
  }
}
