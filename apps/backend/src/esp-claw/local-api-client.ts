import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import {
  CapabilityCatalog,
  LocalStatus,
  parseCapabilityCatalog,
  parseLocalStatus,
} from "@esp-claw/protocol";

import { assertSafeLocalTarget } from "./local-target";

const DEFAULT_TIMEOUT_MS = 5000;
/** Device introspection responses are small JSON documents; anything larger is refused. */
const MAX_RESPONSE_BYTES = 256 * 1024;

/** DI token: extra hostnames (beyond private/Tailscale IPv4 literals) the client may contact. */
export const LOCAL_API_ALLOWED_HOSTS = "LOCAL_API_ALLOWED_HOSTS";

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

  constructor(@Optional() @Inject(LOCAL_API_ALLOWED_HOSTS) private readonly allowedHosts: string[] = []) {}

  /**
   * Validates an operator-supplied device URL against the SSRF policy and
   * returns its normalized origin (what gets stored as `localApiBaseUrl`).
   * Throws LocalTargetError — callers at the API boundary map it to a 400.
   */
  validateBaseUrl(baseUrl: string): string {
    return assertSafeLocalTarget(baseUrl, this.allowedHosts).origin;
  }

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
    // SSRF guard (audit B3): the host is validated on every call, not only
    // when the API layer accepted it, so no code path can reach this fetch
    // with an unvetted target.
    const target = assertSafeLocalTarget(baseUrl, this.allowedHosts);
    const url = new URL(path, target).toString();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { accept: "application/json" },
        redirect: "manual", // a redirect could bounce the request to an unvetted host
      });
      if (!res.ok) {
        throw new Error(`GET ${url} -> HTTP ${res.status}`);
      }
      const declared = Number(res.headers.get("content-length") ?? 0);
      if (declared > MAX_RESPONSE_BYTES) {
        throw new Error(`GET ${url} -> response too large (${declared} bytes)`);
      }
      const text = await res.text();
      if (text.length > MAX_RESPONSE_BYTES) {
        throw new Error(`GET ${url} -> response too large`);
      }
      return JSON.parse(text);
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
