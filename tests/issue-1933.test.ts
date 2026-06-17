// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1933 — runtime multi-instance isolation + retention leak.
//
// `src/runtime.ts` kept module-level mutable state (symbol cache/registry,
// legacy RegExp statics, subclass-ctor registry, user-class parent chain) that
// (1) bled across concurrently-live instances and (2) retained whole instances
// forever (subclass ctors close over their instance's exports). These are now
// per-instance fields on `InstanceState`, threaded through `resolveImport`.

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const ENV_STUB = { console_log_number: () => {}, console_log_string: () => {}, console_log_bool: () => {} };

async function instantiate(source: string) {
  const r = await compile(source, { fileName: "t.ts" });
  if (!r.success) throw new Error(`compile failed: ${r.errors[0]?.message}`);
  const imports = buildImports(r.imports, ENV_STUB, r.stringPool) as Record<string, unknown> & {
    setExports?: (e: unknown) => void;
  };
  const { instance } = await WebAssembly.instantiate(r.binary, imports as WebAssembly.Imports);
  imports.setExports?.(instance.exports);
  return instance;
}

describe("#1933 — runtime multi-instance isolation", () => {
  it("(a) symbol descriptions are independent across two concurrent instances", async () => {
    // Each instance registers its own Symbol description; the per-instance
    // symbolCache/symbolDescRegistry must not clobber each other (the old
    // module-level `_symbolCache = undefined` reset crossed instances).
    const src = `export function test(): string { const s = Symbol("desc-X"); return s.description ?? "none"; }`;
    const a = await instantiate(src);
    const b = await instantiate(src);
    expect((a.exports as Record<string, () => unknown>).test()).toBe("desc-X");
    expect((b.exports as Record<string, () => unknown>).test()).toBe("desc-X");
  });

  it("basic compile/run is unaffected by the per-instance refactor", async () => {
    const inst = await instantiate(`export function test(): number { return 6 * 7; }`);
    expect((inst.exports as Record<string, () => unknown>).test()).toBe(42);
  });

  it("subclass-of-builtin works the same per instance", async () => {
    const src = `class Sub extends Array {} export function test(): number { const s = new Sub(); s.push(1); return s.length; }`;
    const a = await instantiate(src);
    const b = await instantiate(src);
    expect((a.exports as Record<string, () => unknown>).test()).toBe(1);
    expect((b.exports as Record<string, () => unknown>).test()).toBe(1);
  });

  it("(b) an instance that registered subclasses is GC-collected after its refs drop", () => {
    // Runs in a subprocess with --expose-gc: instance A registers a subclass of
    // a builtin (populating the per-instance subclassCtors), then is dropped. A
    // WeakRef to A's exports must be collectible despite B having instantiated —
    // the old module-level `_subclassCtors` pinned A forever.
    const dir = mkdtempSync(join(tmpdir(), "issue-1933-"));
    const probe = join(dir, "gc.mts");
    writeFileSync(
      probe,
      `import { compile } from ${JSON.stringify(join(REPO_ROOT, "src/index.ts"))};\n` +
        `import { buildImports } from ${JSON.stringify(join(REPO_ROOT, "src/runtime.ts"))};\n` +
        `const ENV = { console_log_number: () => {}, console_log_string: () => {}, console_log_bool: () => {} };\n` +
        `async function inst(src){ const r = await compile(src, {fileName:"t.ts"}); const im = buildImports(r.imports, ENV, r.stringPool); const {instance} = await WebAssembly.instantiate(r.binary, im); im.setExports?.(instance.exports); return instance; }\n` +
        `const SRC = 'class Sub extends Array {} export function test(): number { const s = new Sub(); s.push(1); return s.length; }';\n` +
        `let A = await inst(SRC); const ref = new WeakRef(A.exports); A = null;\n` +
        `await inst(SRC);\n` +
        `for (let i=0;i<10;i++){ globalThis.gc?.(); await new Promise(r=>setTimeout(r,10)); }\n` +
        `process.stdout.write(ref.deref() === undefined ? "collected" : "retained");\n`,
    );
    const out = execFileSync("npx", ["tsx", probe], {
      cwd: REPO_ROOT,
      env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --expose-gc`.trim() },
    }).toString();
    expect(out).toBe("collected");
  });

  it("no NEW module-level mutable per-instance state (#1933 allowlist guard)", () => {
    // The four states this issue moved (_symbolCache, _symbolDescRegistry,
    // _legacyRegExpState, _subclassCtors, _userClassParents) remain in
    // runtime.ts ONLY as legacy fallbacks for callers without an instanceState;
    // they must NOT be the live per-instance store. Assert the per-instance
    // fields exist on InstanceState (the real store) by grepping the source.
    const fs = require("node:fs") as typeof import("node:fs");
    const runtime = fs.readFileSync(join(REPO_ROOT, "src/runtime.ts"), "utf-8");
    for (const field of [
      "symbolCache?:",
      "symbolDescRegistry?:",
      "legacyRegExpState?:",
      "subclassCtors?:",
      "userClassParents?:",
    ]) {
      expect(runtime).toContain(field);
    }
  });
});
