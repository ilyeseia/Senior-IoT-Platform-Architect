import { Injectable, Logger } from "@nestjs/common";
import {
  CapabilityCatalog,
  LocalStatus,
  parseCapabilityCatalog,
  parseLocalStatus,
} from "@esp-claw/protocol";

const DEFAULT_TIMEOUT_MS = 5000;

/**
 * The device's local HTTP surface is LAN-only and unauthenticated, and
 * `GET /api/config` returns secrets (mqtt_password, wg_private_key, LLM api_key)
 * in plaintext (PHASE1-ANALYSIS.md §K). This client therefore only ever reads
 * the two safe introspection endpoints, and refuses anything else by
 * construction — there is no code path here that can fetch `/api/config`.
 */
const ALLOWED_PATHS = new Set(["/api/capabilities", "/api/status"]);

/**
 * ESP-Claw integration/adapter layer (PHASE1-ANALYSIS.md §item-8): reaches a
 * single device's real local HTTP API over the tailnet for one-shot
 * introspection. All *ongoing* platform↔device traffic still goes over MQTT —
 * this is only the pull-once discovery path (capability catalog + status).
 */
@Injectable()
export class LocalApiClient {
  private readonly logger = new Logger(LocalApiClient.name);

  async fetchCapabilities(baseUrl: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<CapabilityCatalog> {
    return parseCapabilityCatalog(await this.getJson(baseUrl, "/api/capabilities", timeoutMs));
  }

  async fetchStatus(baseUrl: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<LocalStatus> {
    return parseLocalStatus(await this.getJson(baseUrl, "/api/status", timeoutMs));
  }

  private async getJson(baseUrl: string, path: string, timeoutMs: number): Promise<unknown> {
    if (!ALLOWED_PATHS.has(path)) {
      throw new Error(`LocalApiClient refuses non-introspection path: ${path}`);
    }
    const url = buildLocalUrl(baseUrl, path);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { accept: "application/json" },
      });
      if (!res.ok) {
        throw new Error(`GET ${url} -> HTTP ${res.status}`);
      }
      return await res.json();
    } catch (err) {
      this.logger.warn(`local API GET ${url} failed: ${(err as Error).message}`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Accepts a bare host/IP ("100.101.102.103"), a host:port, or a full
 * "http://host" base and returns an absolute URL for `path`. Defaults to http
 * because the device serves plain HTTP on the LAN/tailnet (no TLS on-device).
 */
export function buildLocalUrl(baseUrl: string, path: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    throw new Error("baseUrl is empty");
  }
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  return new URL(path, withScheme).toString();
}
