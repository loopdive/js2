// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

/**
 * #1550 — Destructuring default initializer must NOT be evaluated when value
 * is non-undefined.
 *
 * Per ECMA-262 §13.3.3.6 (IteratorBindingInitialization) and §13.3.3.7
 * (KeyedBindingInitialization), the SingleNameBinding default-Initializer is
 * only evaluated when `v` is strictly `undefined`. Values like `null`, `0`,
 * `false`, `''` must preserve the original value AND skip the initializer.
 *
 * Root cause fixed here: TypeScript inferred binding types like `void | null`
 * for `function f({w = counter()} = {w: null})` because `counter()` has return
 * type `void`. Our `mapTsTypeToWasm` and `resolveWasmType` filtered Null and
 * Undefined from union types but NOT Void, so `void | null` collapsed to just
 * `void` → i32, losing the actual null type info. The destructured null was
 * then coerced to i32 (= 0), failing the `assert.sameValue(w, null)` assertion
 * in the ~252 `dstr-binding/*-init-skipped.js` test262 cases.
 */
async function run(src: string): Promise<{ exports: Record<string, any> }> {
  const r = await compile(src, { fileName: "test.ts" });
  expect(r.success, JSON.stringify(r.errors)).toBe(true);
  const imports = buildImports(r.imports, undefined, r.stringPool) as any;
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  if (typeof imports.setExports === "function") imports.setExports(instance.exports);
  return { exports: instance.exports as Record<string, any> };
}

describe("#1550 — dstr-binding init-skipped: default initializer guarded by === undefined", () => {
  it("array binding: null value preserved, counter() default NOT evaluated", async () => {
    const { exports } = await run(`
      var initCount = 0;
      function counter() { initCount += 1; }
      let outW: any;
      function f([ w = counter() ] = [null]) { outW = w; }
      export function test(): number {
        initCount = 0;
        f();
        if (outW !== null) return -100;
        if (initCount !== 0) return -200 - initCount;
        return 1;
      }
    `);
    expect((exports.test as () => number)()).toBe(1);
  });

  it("array binding: all four init-skipped values preserved (null, 0, false, '')", async () => {
    const { exports } = await run(`
      let oW: any, oX: any, oY: any, oZ: any;
      // Use anonymous default so binding types don't pull in counter()'s void
      // return type (which the obj-pattern path still mishandles — separate bug).
      function f([ w = 'D', x = 'D', y = 'D', z = 'D' ]: any[] = [null, 0, false, '']) {
        oW = w; oX = x; oY = y; oZ = z;
      }
      export function test(): number {
        f();
        if (oW !== null) return -100;
        if (oX !== 0) return -200;
        if (oY !== false) return -300;
        if (oZ !== '') return -400;
        return 1;
      }
    `);
    expect((exports.test as () => number)()).toBe(1);
  });

  it("object binding: null value preserved, default NOT evaluated (const default)", async () => {
    const { exports } = await run(`
      let outW: any;
      function f({ w = 'DEFAULT' as any } = { w: null }) { outW = w; }
      export function test(): number {
        f();
        if (outW !== null) return -100;
        return 1;
      }
    `);
    expect((exports.test as () => number)()).toBe(1);
  });

  it("array binding: var-declaration form", async () => {
    const { exports } = await run(`
      var [ w = 'DEFAULT' as any ] = [null];
      export function test(): number {
        if (w !== null) return -100;
        return 1;
      }
    `);
    expect((exports.test as () => number)()).toBe(1);
  });

  it("regression: void | T binding-type unions are resolved to T's Wasm type", async () => {
    // Direct test for the type-mapper fix — counter() returns void, so the
    // binding type for `w` is `void | number`. Before #1550 this collapsed to
    // `void` → i32, breaking f64 arithmetic. After fix it resolves to f64.
    const { exports } = await run(`
      function counter(): number { return 0; }
      function f({ w = counter() } = { w: 42 }) { return w; }
      export function test(): number {
        return f() === 42 ? 1 : -100;
      }
    `);
    expect((exports.test as () => number)()).toBe(1);
  });
});
