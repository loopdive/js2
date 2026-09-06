// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #5342 cause C — the published capability-probe idiom bound `null`:
//
//   var Symbol = typeof globalThis.Symbol === 'function' ? globalThis.Symbol : undefined;
//   var symbol = Symbol ? Symbol('a') : undefined;
//
// Two independent defects compose here, and BOTH are needed for the idiom to
// work; either alone leaves it wrong in a different way.
//
// C1 — `globalThis.Symbol` was compiled as a read of the module global that
// this very statement is defining. The #4500 Slice A arm answers
// `globalThis.<name>` / `this.<name>` from `<name>`'s wasm module global,
// which is right for SCRIPT goal (§9.1.1.4.18 CreateGlobalVarBinding makes a
// script's top-level `var` a property of the global object) and wrong for a
// MODULE (§16.2.1.6.4 puts it in the module environment record, creating no
// global-object property). In module code the arm therefore read a global that
// was still `null`, the true arm stored that null, and the shadow stayed falsy
// for the rest of the module — so every later `Symbol(...)` / `Symbol.iterator`
// read off it was dead. The gate is now script-goal only, on the RECEIVER's own
// source file, honouring `inferModuleStrictArguments === false` so the test262
// harness's synthetic `export function test()` wrapper does not reclassify a
// genuinely script-goal source (Slice A's own witnesses are script tests).
//
// C2 — the ternary join dropped the symbol BRAND. `compileSymbolCall` returns
// the js-host symbol id as a bare `i32` on purpose (#4626: branding it globally
// routed mid-emission coercions through a late `__box_symbol` import whose index
// shift corrupted baked `ref.func` operands). Joining `symbol` with `undefined`
// coerces that `i32` to `externref` — and unbranded it took `__box_number`,
// while the `symbol`-typed sink unboxed with `__unbox_symbol`, which answers 0
// for a JS number. So the fixture produced `Symbol(wasm_0)` instead of
// `Symbol(a)`. The brand is re-attached at the join, which is already prepared
// for a coercion-time late import (both arms are parked in `fctx.savedBodies`).
//
// The script-goal control at the bottom is not decoration: it is the half of
// #4500 this change must NOT take away.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { compile, compileProject, type CompileResult } from "../src/index.js";
import { buildCompiledImports } from "../src/runtime.js";

const roots: string[] = [];
afterAll(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

async function compileFixture(files: Record<string, string>, entry: string): Promise<CompileResult> {
  const root = mkdtempSync(joinPath(tmpdir(), "js2-5342c-"));
  roots.push(root);
  for (const [name, source] of Object.entries(files)) {
    const target = joinPath(root, name);
    mkdirSync(joinPath(target, ".."), { recursive: true });
    writeFileSync(target, source);
  }
  return compileProject(joinPath(root, entry), {
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "gc",
    platform: "node",
  });
}

async function instantiate(result: CompileResult): Promise<WebAssembly.Exports> {
  const imports = buildCompiledImports(result, {}) as Record<string, unknown> & WebAssembly.Imports;
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (imports.setInstance as ((i: WebAssembly.Instance) => void) | undefined)?.(instance);
  (imports.__setInstance as ((i: WebAssembly.Instance) => void) | undefined)?.(instance);
  (instance.exports.__module_init as (() => void) | undefined)?.();
  return instance.exports;
}

const DEP = `
export function text(v) { return String(v); }
export function truthy(v) { return v ? 1 : 0; }
`;

const MAIN = `
import { text, truthy } from './dep.js';

var Symbol = typeof globalThis.Symbol === 'function' ? globalThis.Symbol : undefined;
var Map = typeof globalThis.Map === 'function' ? globalThis.Map : undefined;
var symbol = Symbol ? Symbol('a') : undefined;

export function shadowedSymbolIsLive() { return truthy(Symbol); }
export function shadowedMapIsLive() { return truthy(Map); }
export function shadowedSymbolTypeof() { return typeof Symbol; }
export function probedSymbolText() { return text(symbol); }
export function moduleVarIsNotAGlobalProperty() { return typeof globalThis.symbol; }
export function unshadowedGlobalStillReads() { return truthy(globalThis.Array); }
export function ternarySymbolText(flag) { return text(flag ? Symbol('b') : undefined); }
`;

describe("#5342 module-scope capability probe over globalThis", () => {
  it("binds the real builtin and keeps the symbol's description", async () => {
    const result = await compileFixture({ "dep.js": DEP, "main.js": MAIN }, "main.js");
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    const exports = await instantiate(result);

    // C1. Before the fix both answered 0 — the shadow read its own
    // uninitialised module global.
    expect((exports.shadowedSymbolIsLive as () => number)()).toBe(1);
    expect((exports.shadowedMapIsLive as () => number)()).toBe(1);
    expect((exports.shadowedSymbolTypeof as () => string)()).toBe("function");

    // C2. Before the fix this was 'Symbol(wasm_0)' (brand lost at the join, so
    // the id was boxed as a number and unboxed as a symbol → 0).
    expect((exports.probedSymbolText as () => string)()).toBe("Symbol(a)");

    // Anti-vacuity for C1: the arm must not simply be inverted. A MODULE's
    // top-level `var` is not a property of the global object, so the read has
    // to answer `undefined` — proving we route to the real object rather than
    // to the module global in either direction.
    expect((exports.moduleVarIsNotAGlobalProperty as () => string)()).toBe("undefined");
    expect((exports.unshadowedGlobalStillReads as () => number)()).toBe(1);

    // Anti-vacuity for C2: the same join with a runtime-false condition must
    // still yield `undefined`, not a symbol.
    expect((exports.ternarySymbolText as (flag: number) => string)(1)).toBe("Symbol(b)");
    expect((exports.ternarySymbolText as (flag: number) => string)(0)).toBe("undefined");
  });

  it("keeps the #4500 script-goal answer: a script's top-level var IS a global property", async () => {
    // Script goal — no import/export, so `externalModuleIndicator` is unset and
    // the Slice A arm must still fire. The script throws iff an assertion
    // fails, so "ran to completion" is the assertion.
    const src = `
var p1 = 7;
var p2;
if (globalThis.p1 !== 7) { throw new Error('globalThis.p1'); }
if (globalThis['p1'] !== 7) { throw new Error('globalThis["p1"]'); }
if ((globalThis.p1 === undefined)) { throw new Error('globalThis.p1 nullish read'); }
globalThis['p2'] = 5;
if (p2 !== 5) { throw new Error('globalThis["p2"] write'); }
`;
    const result = await compile(src, {
      fileName: "script.js",
      allowJs: true,
      skipSemanticDiagnostics: true,
      target: "standalone",
    });
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    (instance.exports as { __module_init?: () => void }).__module_init?.();
  });
});
