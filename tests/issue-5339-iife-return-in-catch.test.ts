// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #5339 — a value-returning IIFE is INLINED into its caller, so every `return`
// in its body has to be rewritten into `local.set <ret>; br <iife-exit>`. The
// rewriter (`patchReturns` in `src/codegen/expressions/call-tail-dispatch.ts`)
// walked `if.then` / `if.else` / `<block>.body` — but not the `catches[].body`
// and `catchAll` arms of a legacy `try`. A `return` inside a catch clause was
// therefore left as a Wasm `return`, which returns from the ENCLOSING Wasm
// function instead of from the inlined IIFE.
//
// Two distinct failures fall out of the same omission:
//
//  1. Wrong value, still valid Wasm — when the IIFE's return type happens to
//     match the enclosing function's, the escape type-checks and silently
//     returns the IIFE's value as the caller's:
//       function f() { const v = (function () {
//         try { throw new Error("boom"); } catch { return 1; } })(); return v + 10; }
//       f()  // native 11, wasm 1
//
//  2. Invalid Wasm — when the types differ, the module does not validate at
//     all, which kills the whole module. That is how this surfaced: hono's
//     `getColorEnabledAsync` (`dist/utils/color.js`) awaits an async IIFE whose
//     try/catch returns a boolean; the IIFE's ret local is `externref`
//     (`Promise<boolean>`) while the enclosing function's result is `i32`, so
//     the escaping `return` produced
//       "type error in return[0] (expected i32, got externref)"
//     and took `src/helper/dev/index.test.ts` to 0/8 with a null per-test
//     `wasmError` — the error lives on the module, not on any test.
//
// The standalone / WASI lane was never affected: `buildStandardTryTable`
// lowers handlers into nested `block`s, which the generic `body` recursion
// already reached. Only the JS-host legacy `try` encoding lost the returns.
//
// Fixtures are plain untyped `.js`, matching how the upstream npm suites feed
// package code in; `: any` annotations route through a different arm.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { compileProject } from "../src/index.js";
import { instantiateWithRuntime } from "./equivalence/helpers.js";

const roots: string[] = [];
afterAll(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

const ENTRY = `import { run } from "./mod.js";\nexport function test(): string { return String((run as unknown as () => unknown)()); }`;

async function compileModule(moduleSource: string): Promise<Awaited<ReturnType<typeof compileProject>>> {
  const root = mkdtempSync(join(tmpdir(), "js2-5339-"));
  roots.push(root);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "mod.js"), moduleSource);
  writeFileSync(join(root, "entry.ts"), ENTRY);
  return compileProject(join(root, "entry.ts"), {
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "gc",
    platform: "node",
  });
}

async function runModule(moduleSource: string): Promise<string> {
  const result = await compileModule(moduleSource);
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const instance = await instantiateWithRuntime(result);
  return String((instance.exports as Record<string, () => unknown>).test());
}

/** [name, module source, expected]. Cases marked (was ✗) failed before #5339. */
const cases: Array<[string, string, string]> = [
  [
    "return inside a catch clause stays inside the IIFE (was ✗: 1)",
    `function f() {
  const v = (function () {
    try { throw new Error("boom"); } catch (e) { return 1; }
  })();
  return v + 10;
}
export function run() { return f(); }`,
    "11",
  ],
  [
    "same, arrow IIFE with an omitted catch binding (was ✗: 1)",
    `function f() {
  const v = (() => {
    try { throw new Error("boom"); } catch { return 1; }
  })();
  return v + 10;
}
export function run() { return f(); }`,
    "11",
  ],
  [
    "string-valued escape is equally wrong (was ✗: a)",
    `function f() {
  const v = (function () {
    try { throw new Error("boom"); } catch (e) { return "a"; }
  })();
  return v + "b";
}
export function run() { return f(); }`,
    "ab",
  ],
  [
    "catch nested inside a loop inside the IIFE (was ✗: 1)",
    `function f() {
  const v = (function () {
    for (let i = 0; i < 3; i++) {
      try { throw new Error("boom"); } catch (e) { return i + 1; }
    }
    return 99;
  })();
  return v + 10;
}
export function run() { return f(); }`,
    "11",
  ],
  [
    "the caller keeps running after the IIFE's catch (was ✗: 1)",
    `function f() {
  let log = "";
  const v = (function () {
    try { throw new Error("boom"); } catch (e) { return 1; }
  })();
  log = "after";
  return log + (v + 10);
}
export function run() { return f(); }`,
    "after11",
  ],
  // ── anti-vacuity controls: same shapes, catch clause never entered ─────────
  // These pass with AND without the fix. If a refactor of `patchReturns` ever
  // breaks the ordinary try-body path, these fail while the cases above still
  // pass, which distinguishes "the rewriter is gone" from "catch arms are
  // missed".
  [
    "control — return in the try body (worked before)",
    `function f() {
  const v = (function () {
    try { return 1; } catch (e) { return 2; }
  })();
  return v + 10;
}
export function run() { return f(); }`,
    "11",
  ],
  [
    "control — no try at all (worked before)",
    `function f() {
  const v = (function () { return 1; })();
  return v + 10;
}
export function run() { return f(); }`,
    "11",
  ],
];

describe("#5339 — inlined IIFE returns inside catch clauses", () => {
  it.each(cases)("%s", async (_name, source, expected) => {
    expect(await runModule(source)).toBe(expected);
  });

  // The hono `getColorEnabledAsync` shape, reduced. This one does not even
  // reach execution before the fix: the escaping `return` pushes an externref
  // where the enclosing function's `i32` result is expected.
  it("emits a module that validates for hono's getColorEnabledAsync shape", async () => {
    const result = await compileModule(`export async function getColorEnabledAsync(cond) {
  const isNoColor = cond
    ? await (async () => {
        try {
          return true;
        } catch {
          return false;
        }
      })()
    : true;
  return !isNoColor;
}
export function run() { return typeof getColorEnabledAsync; }`);
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    await expect(WebAssembly.compile(result.binary)).resolves.toBeInstanceOf(WebAssembly.Module);
  });
});
