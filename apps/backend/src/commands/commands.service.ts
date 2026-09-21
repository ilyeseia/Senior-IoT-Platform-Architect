import { Inject, Injectable, Logger, NotFoundException, OnModuleInit } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { randomUUID } from "crypto";
import { Repository } from "typeorm";
import { ResponseEnvelope } from "@esp-claw/protocol";
import { MqttService } from "../mqtt";
import { DevicesService } from "../devices";
import { EVENT_BUS, EventTypes, createEvent, currentContext } from "../platform";
import type { CommandCompletedPayload, CommandCreatedPayload, EventBus } from "../platform";
import { Command, CommandStatus } from "./command.entity";
import { CommandResult } from "./command-result.entity";

export interface DispatchInput {
  name: string;
  input?: Record<string, unknown>;
  timeoutMs?: number;
}

export interface DispatchOutcome {
  command: Command;
  result: CommandResult;
}

const DEFAULT_TIMEOUT_MS = 15000;

/** Authorization denials as reported by the device (see classify()). */
const DENIAL_PATTERN = /is not exposed to the LLM|^Denied agent cap call/;

/**
 * The real "Command Service" from the architecture (PHASE1-ANALYSIS.md §B):
 * the only thing that both writes command history AND calls MqttService to
 * actually publish. Phase 4 built the live MQTT round-trip; this phase adds
 * the DB-backed history/status-classification on top of it.
 */
@Injectable()
export class CommandsService implements OnModuleInit {
  private readonly logger = new Logger(CommandsService.name);

  constructor(
    @InjectRepository(Command) private readonly commands: Repository<Command>,
    @InjectRepository(CommandResult) private readonly results: Repository<CommandResult>,
    private readonly mqtt: MqttService,
    private readonly devices: DevicesService,
    @Inject(EVENT_BUS) private readonly bus: EventBus,
  ) {}

  /**
   * Audit B7: command correlation lives in MqttService's in-memory map (single
   * instance), so any command still `pending` when the process starts can
   * never receive its response — it was orphaned by a crash/restart. Close
   * them out instead of leaving them `pending` forever. This assumes one
   * backend instance, exactly like the in-memory map itself; it must move
   * behind a lease/owner column when Redis-backed correlation lands.
   */
  async onModuleInit(): Promise<void> {
    try {
      const swept = await this.commands.update(
        { status: "pending" },
        { status: "timed_out", resolvedAt: new Date() },
      );
      if (swept.affected) {
        this.logger.warn(`Closed ${swept.affected} orphaned pending command(s) left by a previous run`);
      }
    } catch (err) {
      this.logger.error(`Orphaned-command sweep failed: ${(err as Error).message}`);
    }
  }

  async dispatch(deviceId: string, input: DispatchInput): Promise<DispatchOutcome> {
    // Only registered devices can be commanded (audit B2: dispatching used to
    // auto-create a registry row for any string). Devices register themselves
    // from their retained `status` birth message. The topic prefix always comes
    // from the registry row, never from the caller (audit B4).
    const device = await this.devices.findOne(deviceId);
    if (!device) {
      throw new NotFoundException(`Device ${deviceId} is not registered`);
    }

    const id = randomUUID();
    const startedAtMs = Date.now();
    // Inside an API request this is the request's id; for internal callers (the telemetry poller)
    // there is no request, so the command gets its own — either way both of its events share it.
    const correlationId = currentContext()?.correlationId ?? randomUUID();
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const command = await this.commands.save(
      this.commands.create({
        id,
        deviceId,
        name: input.name,
        input: input.input ?? {},
        status: "pending",
        timeoutMs,
        correlationId,
      }),
    );
    // The command id doubles as the causation id of everything this command triggers.
    this.bus.publish(
      createEvent<CommandCreatedPayload>({
        type: EventTypes.DEVICE_COMMAND_CREATED,
        source: "module:commands",
        deviceId,
        causationId: id,
        correlationId,
        payload: { commandId: id, name: input.name, timeoutMs },
      }),
    );

    let response: ResponseEnvelope;
    try {
      response = await this.mqtt.sendCommand(
        deviceId,
        { name: input.name, input: input.input },
        // Same id on the DB row, the MQTT message and the response (audit B1).
        { baseTopic: device.baseTopic, timeoutMs, id },
      );
    } catch (err) {
      return this.resolveOutcome(
        command,
        { id, ok: false, result: (err as Error).message },
        startedAtMs,
      );
    }

    return this.resolveOutcome(command, response, startedAtMs);
  }

  findAllForDevice(deviceId: string): Promise<Command[]> {
    return this.commands.find({ where: { deviceId }, order: { createdAt: "DESC" } });
  }

  private async resolveOutcome(
    command: Command,
    response: ResponseEnvelope,
    startedAtMs: number,
  ): Promise<DispatchOutcome> {
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
    this.bus.publish(
      createEvent<CommandCompletedPayload>({
        type: EventTypes.DEVICE_COMMAND_COMPLETED,
        source: "module:commands",
        deviceId: command.deviceId,
        causationId: command.id,
        correlationId: command.correlationId ?? undefined,
        payload: {
          commandId: command.id,
          name: command.name,
          status: status as CommandCompletedPayload["status"], // classify() only returns terminal statuses
          ok: response.ok,
          durationMs: Date.now() - startedAtMs,
        },
      }),
    );
    return { command, result };
  }

  /**
   * "rejected" vs "failed": the device's authorization layer (claw_cap.c)
   * denies a call the caller may not make (ROOT_AGENT_ONLY, LOCAL_ONLY, not
   * LLM-callable, ...) with `ok:false` and
   *   "Error: cap '<name>' is not exposed to the LLM[ (reason=<why>)]."
   * ("Denied agent cap call ..." is only a device-side LOG line, never part of
   * the response — matching on it alone, as this method used to, classified
   * every real denial as "failed"; audit B13.) The legacy prefix is still
   * accepted for older firmware/docs. Everything else that fails is a real
   * device-side error.
   */
  private classify(response: ResponseEnvelope): CommandStatus {
    if (response.ok) {
      return "succeeded";
    }
    const text = response.result ?? "";
    if (DENIAL_PATTERN.test(text)) {
      return "rejected";
    }
    if (text.includes("timed out")) {
      return "timed_out";
    }
    return "failed";
  }
}
