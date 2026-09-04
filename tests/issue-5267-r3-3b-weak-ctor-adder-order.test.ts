// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #5267 R3-3(b) — the CanBeHeldWeakly check belongs INSIDE the intrinsic adder
// (§24.3.3.5 step 4 / §24.4.3.1 step 4), so a user-patched
// `WeakMap.prototype.set` / `WeakSet.prototype.add` is CALLED first and its own
// abrupt completion wins.
//
// The constructor drive ran the check before dispatching to the adder, so a
// patched `set` that throws was never reached and the row saw a TypeError where
// it expected the patched adder's own error.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(source: string): Promise<{ value: number; hostImports: string[] }> {
  const result = await compile(source, {
    fileName: "test.ts",
    target: "standalone",
    deferTopLevelInit: true,
    allowJs: true,
    skipSemanticDiagnostics: true,
  });
  if (!result.success) {
    throw new Error(`compile failed: ${result.errors?.[0]?.message ?? "unknown error"}`);
  }
  const module = await WebAssembly.compile(result.binary);
  const hostImports = WebAssembly.Module.imports(module).map((i) => `${i.module}::${i.name}`);
  const instance = await WebAssembly.instantiate(module, {});
  const exports = instance.exports as Record<string, unknown>;
  (exports.__module_init as (() => void) | undefined)?.();
  return { value: (exports.test as () => number)(), hostImports };
}

describe("#5267 R3-3b — a patched weak-collection adder runs before CanBeHeldWeakly", () => {
  it("WeakMap: the patched set is called and its error wins", async () => {
    const { value, hostImports } = await runStandalone(
      `var called = 0;
       var sawOwnError = 0;
       var iterable = {};
       iterable[Symbol.iterator] = function () {
         var n = 0;
         return { next: function () { n++; return { value: [], done: n > 1 }; }, return: function () { return {}; } };
       };
       WeakMap.prototype.set = function () { called = 1; throw new RangeError("from set"); };
       try {
         new WeakMap(iterable);
       } catch (e) {
         sawOwnError = (e instanceof RangeError) ? 1 : 0;
       }
       export function test(): number { return called * 10 + sawOwnError; }`,
    );
    expect(hostImports).toEqual([]);
    expect(value).toBe(11);
  });

  it("WeakSet: the patched add is called and its error wins", async () => {
    const { value, hostImports } = await runStandalone(
      `var called = 0;
       var sawOwnError = 0;
       var iterable = {};
       iterable[Symbol.iterator] = function () {
         var n = 0;
         return { next: function () { n++; return { value: 1, done: n > 1 }; }, return: function () { return {}; } };
       };
       WeakSet.prototype.add = function () { called = 1; throw new RangeError("from add"); };
       try {
         new WeakSet(iterable);
       } catch (e) {
         sawOwnError = (e instanceof RangeError) ? 1 : 0;
       }
       export function test(): number { return called * 10 + sawOwnError; }`,
    );
    expect(hostImports).toEqual([]);
    expect(value).toBe(11);
  });
});
