import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalApiClient, buildLocalUrl } from "../../src/esp-claw/local-api-client";

describe("buildLocalUrl", () => {
  it("adds http:// to a bare host/IP", () => {
    expect(buildLocalUrl("100.108.45.150", "/api/capabilities")).toBe(
      "http://100.108.45.150/api/capabilities",
    );
  });
  it("keeps an explicit scheme and strips nothing needed", () => {
    expect(buildLocalUrl("http://dev.tail1234.ts.net", "/api/status")).toBe(
      "http://dev.tail1234.ts.net/api/status",
    );
  });
  it("throws on an empty base URL", () => {
    expect(() => buildLocalUrl("  ", "/api/status")).toThrow();
  });
});

describe("LocalApiClient", () => {
  const client = new LocalApiClient();
  afterEach(() => vi.restoreAllMocks());

  it("fetches and parses /api/capabilities over the tailnet", async () => {
    const body = {
      items: [
        { group_id: "cap_mqtt", display_name: "MQTT", default_llm_visible: true },
        { group_id: "cap_ota", display_name: "OTA", default_llm_visible: true },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })),
    );

    const catalog = await client.fetchCapabilities("100.108.45.150");

    expect(catalog.items.map((g) => g.group_id)).toEqual(["cap_mqtt", "cap_ota"]);
    expect(fetch).toHaveBeenCalledWith(
      "http://100.108.45.150/api/capabilities",
      expect.objectContaining({ headers: { accept: "application/json" } }),
    );
  });

  it("throws on a non-200 response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    await expect(client.fetchCapabilities("100.108.45.150")).rejects.toThrow(/HTTP 500/);
  });

  it("parses /api/status and keeps unknown fields", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ wifi_connected: true, ip: "10.0.0.9" }), { status: 200 })),
    );
    const status = await client.fetchStatus("http://10.0.0.9");
    expect(status.wifi_connected).toBe(true);
    expect(status.ip).toBe("10.0.0.9");
  });
});

describe("LocalApiClient SSRF policy", () => {
  afterEach(() => vi.restoreAllMocks());

  it("never calls fetch for a public host", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(new LocalApiClient().fetchStatus("http://8.8.8.8")).rejects.toThrow(/host must be/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not follow redirects (a redirect could leave the vetted host)", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 302, headers: { location: "http://8.8.8.8/" } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(new LocalApiClient().fetchStatus("10.0.0.9")).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledWith(
      "http://10.0.0.9/api/status",
      expect.objectContaining({ redirect: "manual" }),
    );
  });

  it("refuses an oversized response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 200, headers: { "content-length": String(10 * 1024 * 1024) } })),
    );
    await expect(new LocalApiClient().fetchStatus("10.0.0.9")).rejects.toThrow(/too large/);
  });

  it("honours the operator host allow-list", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ items: [] }), { status: 200 })));
    const client = new LocalApiClient(["dev.tail1234.ts.net"]);
    await expect(client.fetchCapabilities("dev.tail1234.ts.net")).resolves.toEqual({ items: [] });
    expect(client.validateBaseUrl("dev.tail1234.ts.net")).toBe("http://dev.tail1234.ts.net");
  });
});
