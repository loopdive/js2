// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #5342 cause A — a HOST builtin stored in an object literal's callable
// property trapped when called as a method:
//
//   const _ = { isArray };          // isArray === Array.isArray
//   _.isArray([1, 2, 3]);           // RuntimeError: dereferencing a null pointer
//
// The field's carrier is `externref` and the callable-property dispatcher
// guard-casts it to the closure-wrapper root. For a genuine host function that
// cast yields null, and `emitNullCheckThrow` deliberately rethrows ONLY when
// the PRE-cast value was nullish (#789 — a wrong struct type is meant to fall
// through to a multi-struct dispatch). A live host function is not nullish, so
// the null cast reached `struct.get` and trapped. A wasm trap is not catchable,
// so the whole test file died.
//
// `callablePropertyIsExtractedHostBuiltin` already existed for exactly this
// defect but proved only ONE shape — a shorthand whose value is a binding
// element of `const { isArray } = Array`. lodash publishes
// `var isArray = Array.isArray; module.exports = isArray` and the adapter
// imports it, which that predicate could not see: it stops at the import
// clause. The proof now follows import aliases and single-initializer hops,
// and admits a plain `PropertyAssignment` initializer as well.
//
// Fixtures are untyped `.js` in a two-file project because that is the shape
// the defect arrives in — a published CommonJS/ESM re-export of a builtin,
// consumed through an object literal in another file.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { compileProject, type CompileResult } from "../src/index.js";
import { buildCompiledImports } from "../src/runtime.js";

const roots: string[] = [];
afterAll(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

async function compileFixture(files: Record<string, string>, entry: string): Promise<CompileResult> {
  const root = mkdtempSync(joinPath(tmpdir(), "js2-5342a-"));
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
var isArray = Array.isArray;
var keys = Object.keys;
export { isArray, keys };
export function measure(v) { return v.length; }
`;

const MAIN = `
import { isArray, keys, measure } from './dep.js';

const _ = { isArray, keys, measure, max: Math.max, direct: Array.isArray };

export function shorthandHostBuiltin() { return _.isArray([1, 2, 3]) ? 1 : 0; }
export function shorthandHostBuiltinNegative() { return _.isArray({ 0: 1, length: 1 }) ? 1 : 0; }
export function shorthandHostBuiltinNoArgs() { return _.isArray() ? 1 : 0; }
export function literalHostBuiltin() { return _.direct([7]) ? 1 : 0; }
export function namespaceMember() { return _.max(3, 9); }
export function objectKeysCount() { return _.keys({ a: 1, b: 2 }).length; }
export function compiledClosureStillDispatches() { return _.measure([1, 2, 3, 4]); }
`;

describe("#5342 host builtin in an object-literal callable property", () => {
  it("calls the real host function instead of trapping on a null cast", async () => {
    const result = await compileFixture({ "dep.js": DEP, "main.js": MAIN }, "main.js");
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    const exports = await instantiate(result);

    // Before the fix each of these four threw
    // "RuntimeError: dereferencing a null pointer".
    expect((exports.shorthandHostBuiltin as () => number)()).toBe(1);
    expect((exports.literalHostBuiltin as () => number)()).toBe(1);
    expect((exports.namespaceMember as () => number)()).toBe(9);
    expect((exports.objectKeysCount as () => number)()).toBe(2);

    // Anti-vacuity: the routed call must still compute a real answer, not a
    // constant truth. An array-like object and a missing argument are both
    // `false` for `Array.isArray`.
    expect((exports.shorthandHostBuiltinNegative as () => number)()).toBe(0);
    expect((exports.shorthandHostBuiltinNoArgs as () => number)()).toBe(0);

    // Control: a COMPILED closure in the same literal keeps the typed
    // call_ref path — the routing is scoped to declaration-proven host values.
    expect((exports.compiledClosureStillDispatches as () => number)()).toBe(4);
  });
});
