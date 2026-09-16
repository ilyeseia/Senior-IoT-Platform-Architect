import { describe, expect, it } from "vitest";
import {
  capabilityGroupIds,
  parseCapabilityCatalog,
  parseLocalStatus,
} from "../src/capabilities";

describe("CapabilityCatalog", () => {
  // The exact shape the real firmware returns (http_server_capabilities_api.c).
  const real = {
    items: [
      { group_id: "cap_mqtt", display_name: "MQTT", default_llm_visible: true },
      { group_id: "cap_vpn", display_name: "VPN", default_llm_visible: true },
      { group_id: "cap_ota", display_name: "OTA", default_llm_visible: true },
    ],
  };

  it("parses the real /api/capabilities group shape", () => {
    const cat = parseCapabilityCatalog(real);
    expect(cat.items).toHaveLength(3);
    expect(cat.items[0].group_id).toBe("cap_mqtt");
    expect(cat.items[0].default_llm_visible).toBe(true);
  });

  it("defaults items to [] and fills missing optional fields", () => {
    expect(parseCapabilityCatalog({}).items).toEqual([]);
    const cat = parseCapabilityCatalog({ items: [{ group_id: "cap_system" }] });
    expect(cat.items[0].display_name).toBe("");
    expect(cat.items[0].default_llm_visible).toBe(false);
  });

  it("capabilityGroupIds returns sorted, de-duplicated ids", () => {
    const cat = parseCapabilityCatalog({
      items: [
        { group_id: "cap_vpn" },
        { group_id: "cap_mqtt" },
        { group_id: "cap_vpn" },
      ],
    });
    expect(capabilityGroupIds(cat)).toEqual(["cap_mqtt", "cap_vpn"]);
  });

  it("rejects a non-object payload", () => {
    expect(() => parseCapabilityCatalog(null)).toThrow();
  });
});

describe("LocalStatus", () => {
  it("parses the real /api/status shape and keeps unknown fields", () => {
    const s = parseLocalStatus({ wifi_connected: true, ip: "100.108.45.150", rssi: -55 });
    expect(s.wifi_connected).toBe(true);
    expect(s.ip).toBe("100.108.45.150");
    expect((s as Record<string, unknown>).rssi).toBe(-55);
  });
});
