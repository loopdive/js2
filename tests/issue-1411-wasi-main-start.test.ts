// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1411 — WASI `_start` must call a user `main()`, not just `__module_init`.
 *
 * #1978 correctly stopped splicing the module-init body INTO a user function
 * named `main` (init must run once at module load, not on every `main()`
 * call), moving init into a standalone `__module_init`. But `addWasiStartExport`
 * was left preferring `__module_init` unconditionally as the `_start` target,
 * so a `--target wasi` program WITH a user `main` (e.g. the Native Messaging
 * host, examples/native-messaging/nm_js2wasm_node_fs.ts) wrapped ONLY `__module_init`
 * in `_start`: top-level globals were initialised but the user `main()` never
 * ran. Under real wasmtime the program produced no stdout — the
 * native-messaging smoke check went red (FAIL: stdout frame mismatch).
 *
 * Fix: `addWasiStartExport` runs `applyModuleInitGuard` first (which prepends
 * `call __module_init` to every exported function, including `main`), then
 * prefers an EXPORTED, no-arg, no-result `main` as the `_start` entry. So
 * `_start → main` runs module init exactly once (idempotent guard) and THEN
 * main's body — restoring the program entry without re-introducing the
 * #1978 splice. A NON-exported `main` (the `main()`-calls-itself convention)
 * is reached through the top-level call captured in `__module_init`, so
 * `_start` still wraps `__module_init` there.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { pinPerfFlags } from "./helpers/pin-perf-flags.js";

// (#4157) This file pins an ABSOLUTE function index (the `_start` entry). The
// tuned passes add helper functions, so those indices shift — a shift is not a
// wrong `_start`, but this instrument cannot tell the two apart. Pin the
// inliner off to keep the indices the ones this file counted.
pinPerfFlags({ JS2WASM_IR_INLINE: "0" });

/** Return the funcIdx that `(func $_start ...)` calls (its first `call N`). */
function startCallTarget(wat: string): number | undefined {
  // Isolate the $_start function body.
  const m = wat.match(/\(func \$_start [\s\S]*?\n {2}\)/);
  if (!m) return undefined;
  const call = m[0].match(/\bcall (\d+)/);
  return call ? Number(call[1]) : undefined;
}

/** Map a defined-function name ($main, $__module_init, …) to its module funcIdx
 *  (import funcs occupy the low indices, then defined funcs in textual order). */
function funcIdxByName(wat: string, name: string): number | undefined {
  const numImportFuncs = (wat.match(/\(import [^\n]*\(func /g) || []).length;
  let idx = numImportFuncs;
  for (const line of wat.split("\n")) {
    const dm = line.match(/^ {2}\(func (\$[A-Za-z0-9_$]+)/);
    if (dm) {
      if (dm[1] === name) return idx;
      idx++;
    }
  }
  return undefined;
}

describe("#1411 WASI _start wraps a user main() (not just __module_init)", () => {
  it("an exported main() is the _start entry, with module init run first via the #1789 guard", async () => {
    // Top-level state + an exported `main` that uses it. The fix must wire
    // `_start → main`, and `main` must begin with `call __module_init`.
    const src = `
      let counter = 0;
      counter = 41;
      export function main(): void { counter = counter + 1; }
      export function get(): number { return counter; }
    `;
    const r = await compile(src, { fileName: "test.ts", target: "wasi", skipSemanticDiagnostics: true });
    expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
    const wat = r.wat!;

    // _start must call the user `main`, NOT `__module_init` directly.
    const mainIdx = funcIdxByName(wat, "$main");
    const initIdx = funcIdxByName(wat, "$__module_init");
    expect(mainIdx).toBeDefined();
    expect(initIdx).toBeDefined();
    expect(startCallTarget(wat)).toBe(mainIdx);

    // And the init body is NOT spliced into main (#1978 must stay fixed):
    // module init lives in its own function, reached via the guard prefix.
    expect(wat).toContain("__module_init");
    expect(wat).toMatch(/\(export "_start"/);

    // Functional: instantiate standalone (empty imports). Calling `_start`
    // runs module init (counter = 41) then main's body (counter = 42).
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    const ex = instance.exports as { _start(): void; get(): number };
    ex._start();
    expect(ex.get()).toBe(42);
  });

  it("#1978 stays fixed: top-level init runs once, not on every main() call", async () => {
    // If init were spliced into (or re-run on) `main`, counter would reset to
    // its initial top-level value every call → 42,42,42 instead of 42,43,44.
    const src = `
      let counter = 0;
      counter = 41;
      export function main(): void { counter = counter + 1; }
      export function get(): number { return counter; }
    `;
    const r = await compile(src, { fileName: "test.ts", target: "wasi", skipSemanticDiagnostics: true });
    expect(r.success).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    const ex = instance.exports as { main(): void; get(): number };
    ex.main();
    ex.main();
    ex.main();
    expect(ex.get()).toBe(44); // 41 (init, once) + 3 increments
  });

  it("a NON-exported main() (main()-calls-itself convention) keeps _start → __module_init", async () => {
    // Here `main` is invoked from top-level code, which lives in
    // `__module_init`. `_start` must wrap `__module_init` (so the top-level
    // call to `main` runs) — NOT `main` directly (which would skip init and,
    // being non-exported, carries no guard prefix).
    const src = `function main(): void { /* entry */ } main();`;
    const r = await compile(src, { fileName: "test.ts", target: "wasi", skipSemanticDiagnostics: true });
    expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
    const wat = r.wat!;
    const initIdx = funcIdxByName(wat, "$__module_init");
    expect(initIdx).toBeDefined();
    expect(startCallTarget(wat)).toBe(initIdx);
    expect(wat).toMatch(/\(export "_start"/);
  });

  it("a module with NO main is unregressed: _start → __module_init", async () => {
    const src = `console.log("hi");`;
    const r = await compile(src, { fileName: "test.ts", target: "wasi", skipSemanticDiagnostics: true });
    expect(r.success).toBe(true);
    const wat = r.wat!;
    const initIdx = funcIdxByName(wat, "$__module_init");
    expect(initIdx).toBeDefined();
    expect(startCallTarget(wat)).toBe(initIdx);
  });
});
