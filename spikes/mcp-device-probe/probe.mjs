#!/usr/bin/env node
/**
 * MCP compatibility probe for an ESP-Claw device (audit §19 / §26-4 spike).
 *
 * Question it answers: can a *standard* MCP client (Streamable HTTP, JSON-RPC 2.0) talk to the
 * device's `cap_mcp_server`, and what does the device expose? It is dependency-free (Node >= 20,
 * global fetch) and speaks the wire protocol directly, so a failure points at the device/SDK
 * behaviour, not at a client library. It is READ-ONLY by default.
 *
 *   node probe.mjs http://<device-ip>:18791/mcp                 # handshake + tools/list + claw_list
 *   node probe.mjs <url> --call get_current_time                # also invoke one capability via claw_call
 *   node probe.mjs <url> --call mqtt_status --args '{}' --json  # machine-readable report
 *
 * Prerequisites on the device: MCP is OFF by default since the Stage-0 firmware hardening; enable it
 * first (`mcp_enabled = "true"` via the device's /api/config, then reboot). Defaults: port 18791,
 * endpoint "mcp". Use only on a trusted LAN/tailnet: the device MCP transport has no authentication.
 *
 * Exit code: 0 = every step passed, 1 = a step failed, 2 = bad usage.
 */

const args = process.argv.slice(2);
const url = args.find((a) => /^https?:\/\//.test(a));
const flag = (name) => args.includes(name);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

if (!url || flag("--help")) {
  console.error("usage: node probe.mjs <http://device:18791/mcp> [--call <capability>] [--args '<json>'] [--json]");
  process.exit(2);
}

const REQUESTED_PROTOCOL = opt("--protocol") ?? "2025-11-25";
const TIMEOUT_MS = Number(opt("--timeout") ?? 10_000);
const steps = [];
let sessionId;
let negotiatedProtocol;
let nextId = 1;

function record(name, ok, detail) {
  steps.push({ name, ok, detail });
  if (!flag("--json")) {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  —  ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  }
  return ok;
}

/** Parses either a plain JSON body or a single-event SSE body (Streamable HTTP allows both). */
function parseBody(contentType, text) {
  if (!text.trim()) return null;
  if (contentType?.includes("text/event-stream")) {
    const data = text
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .join("");
    return data ? JSON.parse(data) : null;
  }
  return JSON.parse(text);
}

async function rpc(method, params, { notification = false } = {}) {
  const body = { jsonrpc: "2.0", method, ...(params ? { params } : {}) };
  if (!notification) body.id = nextId++;

  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  if (negotiatedProtocol) headers["mcp-protocol-version"] = negotiatedProtocol;

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const newSession = res.headers.get("mcp-session-id");
  if (newSession) sessionId = newSession;
  const text = await res.text();
  if (notification) return { status: res.status };
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}: ${text.slice(0, 200)}`);
  const json = parseBody(res.headers.get("content-type"), text);
  if (json?.error) throw new Error(`JSON-RPC error ${json.error.code}: ${json.error.message}`);
  return json?.result;
}

async function step(name, fn) {
  try {
    const detail = await fn();
    return record(name, true, detail);
  } catch (err) {
    record(name, false, err.message);
    return false;
  }
}

async function main() {
  let ok = await step("initialize", async () => {
    const result = await rpc("initialize", {
      protocolVersion: REQUESTED_PROTOCOL,
      capabilities: {},
      clientInfo: { name: "esp-claw-platform-probe", version: "0.1.0" },
    });
    negotiatedProtocol = result.protocolVersion;
    return {
      requested: REQUESTED_PROTOCOL,
      negotiated: result.protocolVersion,
      server: result.serverInfo,
      capabilities: Object.keys(result.capabilities ?? {}),
      sessionId: sessionId ? "issued" : "none",
    };
  });
  if (!ok) return finish(false);

  ok = await step("notifications/initialized", async () => {
    const r = await rpc("notifications/initialized", undefined, { notification: true });
    if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
    return `HTTP ${r.status}`;
  });

  let tools = [];
  ok = (await step("tools/list", async () => {
    let cursor;
    do {
      const page = await rpc("tools/list", cursor ? { cursor } : {});
      tools.push(...(page.tools ?? []));
      cursor = page.nextCursor;
    } while (cursor);
    return { count: tools.length, names: tools.map((t) => t.name) };
  })) && ok;

  const hasBridge = tools.some((t) => t.name === "claw_list") && tools.some((t) => t.name === "claw_call");
  ok = record("bridge tools present (claw_list, claw_call)", hasBridge, hasBridge ? undefined : "device exposes other tools only") && ok;

  if (hasBridge) {
    let listed = [];
    ok = (await step("tools/call claw_list", async () => {
      const result = await rpc("tools/call", { name: "claw_list", arguments: {} });
      const text = (result.content ?? []).map((c) => c.text ?? "").join("");
      listed = JSON.parse(text);
      if (!Array.isArray(listed)) throw new Error("claw_list did not return a JSON array");
      return { capabilities: listed.length, sample: listed.slice(0, 5).map((c) => c.name) };
    })) && ok;

    // Hardening check: LOCAL_ONLY tools must be invisible to a remote MCP caller.
    const leaked = ["write_file", "delete_file", "add_router_rule", "scheduler_add", "register_skill"].filter((n) =>
      listed.some((c) => c.name === n),
    );
    ok = record("LOCAL_ONLY tools hidden from remote callers", leaked.length === 0, leaked.length ? { leaked } : undefined) && ok;

    const callName = opt("--call");
    if (callName) {
      const callArgs = opt("--args") ?? "{}";
      ok = (await step(`tools/call claw_call ${callName}`, async () => {
        const result = await rpc("tools/call", { name: "claw_call", arguments: { name: callName, args: callArgs } });
        const text = (result.content ?? []).map((c) => c.text ?? "").join("");
        return { isError: !!result.isError, output: text.slice(0, 300) };
      })) && ok;
    }
  }

  return finish(ok);
}

function finish(ok) {
  if (flag("--json")) console.log(JSON.stringify({ url, ok, negotiatedProtocol, steps }, null, 2));
  else console.log(`\n${ok ? "RESULT: standard MCP client handshake works" : "RESULT: see failing steps above"}`);
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error("probe crashed:", err);
  process.exit(1);
});
