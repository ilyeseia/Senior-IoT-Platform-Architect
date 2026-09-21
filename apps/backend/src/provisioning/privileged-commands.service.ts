import { BadRequestException, Inject, Injectable, UnprocessableEntityException } from "@nestjs/common";
import { CommandsService } from "../commands";
import type { DispatchOutcome } from "../commands";
import { EVENT_BUS, EventTypes, createEvent } from "../platform";
import type { EventBus, PrivilegedExecutedPayload } from "../platform";
import { PlatformTokenService } from "./platform-token.service";
import {
  PlatformTokenError,
  isPlatformExecTarget,
  redactSecrets,
  validatePrivilegedInput,
} from "./platform-exec";

/**
 * Runs a root-only capability on a device through its `platform_exec` trust path. The flow:
 * validate → sign a short-lived, single-use, device-bound token → send `platform_exec` over the
 * normal command path. What is PERSISTED and audited is the logical operation
 * (`platform_exec:ota_update` + its input with secrets redacted), never the token and never a
 * password: anyone allowed to read command history (viewers) must not be able to replay or read
 * credentials from it.
 */
@Injectable()
export class PrivilegedCommandsService {
  constructor(
    private readonly tokens: PlatformTokenService,
    private readonly commands: CommandsService,
    @Inject(EVENT_BUS) private readonly bus: EventBus,
  ) {}

  async execute(
    deviceId: string,
    capability: string,
    input: Record<string, unknown>,
    actor: string | null,
    timeoutMs?: number,
  ): Promise<DispatchOutcome> {
    if (!isPlatformExecTarget(capability)) {
      throw new BadRequestException(`"${capability}" cannot be triggered through platform_exec`);
    }

    let token: string;
    try {
      validatePrivilegedInput(capability, input);
      token = this.tokens.issue(deviceId, capability, input).token;
    } catch (err) {
      if (err instanceof PlatformTokenError) {
        throw err.kind === "too_large" ? new UnprocessableEntityException(err.message) : new BadRequestException(err.message);
      }
      throw err; // e.g. ServiceUnavailableException when the master key is not configured
    }

    const outcome = await this.commands.dispatch(deviceId, {
      name: "platform_exec",
      input: { token },
      timeoutMs,
      record: { name: `platform_exec:${capability}`, input: redactSecrets(input) as Record<string, unknown> },
    });

    this.bus.publish(
      createEvent<PrivilegedExecutedPayload>({
        type: EventTypes.SECURITY_PRIVILEGED_EXECUTED,
        source: "module:provisioning",
        deviceId,
        causationId: outcome.command.id,
        payload: { commandId: outcome.command.id, capability, actor, status: outcome.command.status },
      }),
    );
    return outcome;
  }
}
