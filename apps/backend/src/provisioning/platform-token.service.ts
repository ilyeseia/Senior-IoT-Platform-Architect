import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Env } from "../config/env.validation";
import { deriveDeviceSecret, fromBase64Url, signPlatformToken, toBase64Url } from "./platform-exec";
import type { SignedToken } from "./platform-exec";

/**
 * Issues `platform_exec` tokens. The only secret it holds is the master key (env
 * `PLATFORM_MASTER_KEY`, never stored in the database or logged); each device's signing secret is
 * derived from it on demand (see deriveDeviceSecret), so a leaked per-device secret does not expose
 * the master key or any other device. Without the key the privileged features answer 503 and
 * everything else in the platform works as before.
 */
@Injectable()
export class PlatformTokenService {
  private readonly masterKey: Buffer | null;
  /** Clock in Unix seconds; a plain field so tests can move time. */
  now: () => number = () => Math.floor(Date.now() / 1000);

  constructor(config: ConfigService<Env, true>) {
    const raw = config.get("PLATFORM_MASTER_KEY", { infer: true });
    this.masterKey = raw ? fromBase64Url(raw) : null;
  }

  isConfigured(): boolean {
    return this.masterKey !== null;
  }

  issue(deviceId: string, capability: string, input: Record<string, unknown>): SignedToken {
    return signPlatformToken({
      secret: this.requireKey(deviceId),
      deviceId,
      capability,
      input,
      nowSeconds: this.now(),
    });
  }

  /** The secret to install on the device with `platform_configure` (base64url). Used by the local provisioning script, never exposed over HTTP. */
  deviceSecret(deviceId: string): string {
    return toBase64Url(this.requireKey(deviceId));
  }

  private requireKey(deviceId: string): Buffer {
    if (!this.masterKey) {
      throw new ServiceUnavailableException("Privileged operations are not configured (PLATFORM_MASTER_KEY is not set)");
    }
    return deriveDeviceSecret(this.masterKey, deviceId);
  }
}
