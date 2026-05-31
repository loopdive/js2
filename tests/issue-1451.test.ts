// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

/**
 * #1451 — Class / object-literal method parameter destructuring with
 * non-trivial defaults.
 *
 * Per ECMA-262 §13.3.3.6 (IteratorBindingInitialization), method param
 * destructuring follows the same iterator-step semantics as function-decl
 * param destructuring. #1432 fixed the function-decl path; this issue
 * ports the same logic to:
 *
 *   - class method emitter   (class-bodies.ts:1175-1212)
 *   - class constructor      (class-bodies.ts:869-893)
 *   - class setter           (class-bodies.ts:1535-1559)
 *
 * Root cause: when a method param has a binding pattern (e.g.
 * `method([_a, _b, ...x] = [1, 2])`) and the param is widened to
 * `externref` via `bindingPatternNeedsWiden`, the default's array literal
 * `[1, 2]` was compiled as a tuple struct (TS contextual type) rather
 * than a vec. The rest-element handler in `destructureParamArray` then
 * cast the tuple to a vec at runtime and trapped on `array.copy` (or
 * dereferenced a null pointer when the cast surfaced as a null ref).
 *
 * Fix: at the default-init site, set the `_arrayLiteralForceVec` context
 * flag while compiling the initializer when the binding pattern is an
 * array pattern and the param slot is externref — mirroring
 * function-body.ts:701 and closures.ts:935 (object-literal methods,
 * which already had the fix).
 */
async function run(src: string): Promise<{ exports: Record<string, any> }> {
  const r = await compile(src, { fileName: "test.ts" });
  expect(r.success, JSON.stringify(r.errors)).toBe(true);
  const imports = buildImports(r.imports, undefined, r.stringPool) as any;
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  if (typeof imports.setExports === "function") imports.setExports(instance.exports);
  return { exports: instance.exports as Record<string, any> };
}

describe("#1451 — class/object method param destructuring with defaults", () => {
  // ──────────────────────────────────────────────────────────────────
  // Class methods — array binding pattern + default
  // ──────────────────────────────────────────────────────────────────

  it("class method: [a, b, c] = [1, 2, 3] → default fires when arg omitted", async () => {
    const { exports } = await run(`
      class C { m([a, b, c] = [1, 2, 3]): number { return a + b + c; } }
      export function test(): number { return new C().m(); }
    `);
    expect((exports.test as () => number)()).toBe(6);
  });

  it("class method: [, , ...x] = [1, 2] → x.length is 0 (rest exhausted)", async () => {
    // Direct equivalent of test262
    // language/statements/class/dstr/meth-dflt-ary-ptrn-rest-id-exhausted.js
    const { exports } = await run(`
      class C { m([_a, _b, ...x] = [1, 2]): number { return x.length; } }
      export function test(): number { return new C().m(); }
    `);
    expect((exports.test as () => number)()).toBe(0);
  });

  it("class method: nested array pattern with inner default", async () => {
    // Equivalent of meth-dflt-ary-ptrn-elem-ary-elision-init.js
    const { exports } = await run(`
      class C { m([[x, y, z] = [4, 5, 6]] = []): number { return x + y + z; } }
      export function test(): number { return new C().m(); }
    `);
    expect((exports.test as () => number)()).toBe(15);
  });

  it("class method: static method with array default fires correctly", async () => {
    const { exports } = await run(`
      class C { static m([a, b] = [3, 4]): number { return a + b; } }
      export function test(): number { return C.m(); }
    `);
    expect((exports.test as () => number)()).toBe(7);
  });

  it("class method: explicit undefined fires default", async () => {
    const { exports } = await run(`
      class C { m([a, b] = [10, 20]): number { return a + b; } }
      export function test(): number { return new C().m(undefined as any); }
    `);
    expect((exports.test as () => number)()).toBe(30);
  });

  it("class method: explicit null on binding pattern throws TypeError", async () => {
    const { exports } = await run(`
      class C { m([a, b]: any): number { return a + b; } }
      export function test(): number {
        try { new C().m(null as any); return -1; }
        catch (e: any) { return 1; }
      }
    `);
    expect((exports.test as () => number)()).toBe(1);
  });

  it("class method: arg provided → default does not fire", async () => {
    const { exports } = await run(`
      class C { m([a, b] = [10, 20]): number { return a + b; } }
      export function test(): number { return new C().m([100, 200] as any); }
    `);
    expect((exports.test as () => number)()).toBe(300);
  });

  // ──────────────────────────────────────────────────────────────────
  // Class methods — object binding pattern + default
  // ──────────────────────────────────────────────────────────────────

  it("class method: {a, b} = {a:5, b:7} → default fires when arg omitted", async () => {
    const { exports } = await run(`
      class C { m({a, b}: {a:number, b:number} = {a: 5, b: 7}): number { return a + b; } }
      export function test(): number { return new C().m(); }
    `);
    expect((exports.test as () => number)()).toBe(12);
  });

  it("class method: {a = 1} with arg {a:2} keeps a=2 (inner init not used)", async () => {
    // Equivalent of meth-dflt-obj-ptrn-id-init-skipped.js
    const { exports } = await run(`
      class C { m({a = 1}: {a?: number} = {a: 2}): number { return a; } }
      export function test(): number { return new C().m(); }
    `);
    expect((exports.test as () => number)()).toBe(2);
  });

  // ──────────────────────────────────────────────────────────────────
  // Generator methods
  // ──────────────────────────────────────────────────────────────────

  it("generator method: [a, b] = [1, 2] default + iter yields", async () => {
    const { exports } = await run(`
      class C { *m([a, b] = [1, 2]) { yield a; yield b; } }
      export function test(): number {
        const g = new C().m();
        const v1 = g.next().value;
        const v2 = g.next().value;
        return (v1 === 1 && v2 === 2) ? 1 : 0;
      }
    `);
    expect((exports.test as () => number)()).toBe(1);
  });

  it("static generator method with object pattern compiles + runs", async () => {
    // Equivalent of gen-meth-static-obj-ptrn-list-err.js shape
    const { exports } = await run(`
      class C { static *m({a}: any) { yield a; } }
      export function test(): number {
        const g = C.m({a: 42});
        return g.next().value === 42 ? 1 : 0;
      }
    `);
    expect((exports.test as () => number)()).toBe(1);
  });

  it("generator method: rest after elision with default fires", async () => {
    const { exports } = await run(`
      class C { *m([_a, _b, ...x] = [1, 2]) { yield x.length; } }
      export function test(): number {
        const g = new C().m();
        return g.next().value === 0 ? 1 : 0;
      }
    `);
    expect((exports.test as () => number)()).toBe(1);
  });

  // ──────────────────────────────────────────────────────────────────
  // Object literal methods (closures.ts path — already has the fix)
  // Regression coverage so the path stays correct.
  // ──────────────────────────────────────────────────────────────────

  it("object literal method: [a, b] = [10, 20] default", async () => {
    const { exports } = await run(`
      const o = { m([a, b] = [10, 20]): number { return a + b; } };
      export function test(): number { return o.m(); }
    `);
    expect((exports.test as () => number)()).toBe(30);
  });

  it("object literal method: {a, ...rest} pattern with object default", async () => {
    const { exports } = await run(`
      const o = { m({a, ...rest}: any = {a: 1, b: 2, c: 3}): number { return a + rest.b + rest.c; } };
      export function test(): number { return o.m(); }
    `);
    expect((exports.test as () => number)()).toBe(6);
  });

  it("object literal method: rest with elision default (externref-typed)", async () => {
    // Force externref param via `any` annotation so the default literal flows
    // through the externref path (mirrors the class-method widen behaviour
    // from `bindingPatternNeedsWiden`).
    const { exports } = await run(`
      const o = { m([_a, _b, ...x]: any = [1, 2]): number { return x.length; } };
      export function test(): number { return o.m(); }
    `);
    expect((exports.test as () => number)()).toBe(0);
  });
});
