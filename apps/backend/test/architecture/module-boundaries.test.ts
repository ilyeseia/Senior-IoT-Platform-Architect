import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

/**
 * Architecture fitness test (ADVANCED-ARCHITECTURE-AUDIT.md §4 "strict module boundaries").
 * It reads the real imports under src/ and fails when a module reaches into another module's
 * internals, depends on a module it is not allowed to, or when the module graph has a cycle.
 * No extra tooling: this runs with the rest of the suite, so a violation breaks `pnpm test`.
 *
 * ALLOWED is the single, reviewable statement of the architecture. Changing it is a design
 * decision — do it deliberately, and update docs/architecture/STAGE1-MODULE-BOUNDARIES.md.
 */
const SRC = resolve(__dirname, "../../src");

/** Shared, dependency-free libraries: importable from anywhere, including their internal files. */
const SHARED = new Set(["common", "config"]);

/**
 * module -> modules it may depend on (besides SHARED and `platform`, which anyone may use).
 * Read as: "commands may use devices and mqtt".
 */
const ALLOWED: Record<string, string[]> = {
  platform: [], // the kernel depends on nothing
  database: [],
  identity: [],
  audit: [], // consumes events; knows no producer
  "esp-claw": [], // integration adapter (topic scheme, local HTTP)
  mqtt: ["esp-claw"], // device gateway
  devices: ["esp-claw"], // registry
  commands: ["devices", "mqtt"],
  telemetry: ["devices", "commands"],
  twin: ["devices"],
  health: ["mqtt"], // readiness reports broker state
  observability: ["mqtt"], // metrics observe the platform; nothing depends on observability
};

const APP_ROOT_FILES = new Set(["app.module.ts", "main.ts"]); // composition root: may import every module's public API

function listTs(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? listTs(full) : full.endsWith(".ts") ? [full] : [];
  });
}

interface Import {
  from: string; // file (relative to src, posix)
  fromModule: string;
  spec: string;
  target: string; // resolved path relative to src, posix, without extension
  toModule: string;
}

const posix = (p: string) => p.split(sep).join("/");
const moduleOf = (relPosix: string) => relPosix.split("/")[0].replace(/\.ts$/, "");

function collectImports(): Import[] {
  const imports: Import[] = [];
  const re = /(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']*)["']/g;
  for (const file of listTs(SRC)) {
    const rel = posix(relative(SRC, file));
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(re)) {
      const target = posix(relative(SRC, resolve(dirname(file), m[1])));
      if (target.startsWith("..")) continue;
      imports.push({ from: rel, fromModule: moduleOf(rel), spec: m[1], target, toModule: moduleOf(target) });
    }
  }
  return imports;
}

const all = collectImports();
const cross = all.filter((i) => i.fromModule !== i.toModule && !APP_ROOT_FILES.has(i.from));
const modules = Object.keys(ALLOWED);

describe("module boundaries", () => {
  it("every top-level folder under src is a declared module or shared library", () => {
    const folders = readdirSync(SRC).filter((n) => statSync(join(SRC, n)).isDirectory());
    const undeclared = folders.filter((f) => !modules.includes(f) && !SHARED.has(f));
    expect(undeclared, `declare these in ALLOWED (or SHARED): ${undeclared.join(", ")}`).toEqual([]);
  });

  it("each feature module exposes a public API (index.ts)", () => {
    const missing = modules.filter((m) => {
      try {
        statSync(join(SRC, m, "index.ts"));
        return false;
      } catch {
        return true;
      }
    });
    expect(missing).toEqual([]);
  });

  it("modules only depend on modules they are allowed to", () => {
    const violations = cross
      .filter((i) => !SHARED.has(i.toModule) && i.toModule !== "platform")
      .filter((i) => !(ALLOWED[i.fromModule] ?? []).includes(i.toModule))
      .map((i) => `${i.from} -> ${i.toModule} (${i.spec})`);
    expect(violations).toEqual([]);
  });

  it("modules reach other modules only through their public API, never their internals", () => {
    const violations = cross
      .filter((i) => !SHARED.has(i.toModule))
      .filter((i) => i.target !== i.toModule && i.target !== `${i.toModule}/index`)
      .map((i) => `${i.from} imports the internals of ${i.toModule}: ${i.spec}`);
    expect(violations).toEqual([]);
  });

  it("the platform kernel and shared libraries depend on no feature module", () => {
    const violations = all
      .filter((i) => (i.fromModule === "platform" || SHARED.has(i.fromModule)) && i.fromModule !== i.toModule)
      .map((i) => `${i.from} -> ${i.toModule}`);
    expect(violations).toEqual([]);
  });

  it("the module dependency graph has no cycles", () => {
    const graph = new Map<string, Set<string>>();
    for (const i of cross) {
      if (SHARED.has(i.toModule) || i.toModule === "platform") continue;
      graph.set(i.fromModule, (graph.get(i.fromModule) ?? new Set()).add(i.toModule));
    }
    const visiting = new Set<string>();
    const done = new Set<string>();
    const cycles: string[] = [];
    const visit = (node: string, path: string[]) => {
      if (done.has(node)) return;
      if (visiting.has(node)) {
        cycles.push([...path.slice(path.indexOf(node)), node].join(" -> "));
        return;
      }
      visiting.add(node);
      for (const next of graph.get(node) ?? []) visit(next, [...path, node]);
      visiting.delete(node);
      done.add(node);
    };
    for (const node of graph.keys()) visit(node, []);
    expect(cycles).toEqual([]);
  });

  it("actually detects a violation (guard against a vacuous test)", () => {
    // The scanner must see real imports; if it found none, every check above would pass trivially.
    expect(all.length).toBeGreaterThan(50);
    expect(cross.length).toBeGreaterThan(10);
    expect(cross.some((i) => i.fromModule === "commands" && i.toModule === "devices")).toBe(true);
  });
});
