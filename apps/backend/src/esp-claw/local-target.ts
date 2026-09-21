/**
 * SSRF guard for LocalApiClient (audit finding B3). The device's local HTTP
 * API is only ever reachable on a LAN/tailnet, so the platform only agrees to
 * talk to:
 *   - http:// (the device serves plain HTTP; no other scheme is meaningful),
 *   - no embedded credentials, port 80 or 8080 only,
 *   - a host that is EITHER an IPv4 literal in a private/Tailscale range
 *     (10/8, 172.16/12, 192.168/16, 100.64/10 CGNAT — minus the well-known
 *     cloud-metadata address inside that CGNAT block) OR an exact hostname
 *     the operator explicitly allow-listed (LOCAL_API_ALLOWED_HOSTS).
 * Loopback, link-local (169.254/16 — cloud metadata), IPv6 literals and
 * arbitrary DNS names are refused. Hostnames are only trusted through the
 * explicit allow-list because a DNS name can resolve anywhere.
 */
export class LocalTargetError extends Error {}

const ALLOWED_PORTS = new Set([80, 8080]);
const CLOUD_METADATA_IPS = new Set(["100.100.100.200"]); // Alibaba Cloud metadata, inside 100.64/10

export function parseAllowedHosts(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h.length > 0);
}

export function assertSafeLocalTarget(baseUrl: string, allowedHosts: readonly string[] = []): URL {
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    throw new LocalTargetError("baseUrl is empty");
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new LocalTargetError("baseUrl is not a valid URL");
  }

  if (url.protocol !== "http:") {
    throw new LocalTargetError("only http:// device URLs are allowed");
  }
  if (url.username || url.password) {
    throw new LocalTargetError("credentials in the URL are not allowed");
  }
  const port = url.port === "" ? 80 : Number(url.port);
  if (!ALLOWED_PORTS.has(port)) {
    throw new LocalTargetError("port not allowed (use 80 or 8080)");
  }

  const host = url.hostname.toLowerCase();
  if (isPrivateIPv4(host)) {
    return url;
  }
  if (allowedHosts.includes(host)) {
    return url;
  }
  throw new LocalTargetError(
    "host must be a private/Tailscale IPv4 address or listed in LOCAL_API_ALLOWED_HOSTS",
  );
}

export function isPrivateIPv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) {
    return false;
  }
  const octets = m.slice(1).map(Number);
  if (octets.some((o) => o > 255)) {
    return false;
  }
  if (CLOUD_METADATA_IPS.has(host)) {
    return false;
  }
  const [a, b] = octets;
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}
