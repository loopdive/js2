// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile, compileToWat } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

/**
 * #1432 — Parameter list: rest/destructuring iterator semantics + default
 * initializers.
 *
 * Per ECMA-262 §13.3.3.6 (IteratorBindingInitialization), only the truly-
 * empty `ArrayBindingPattern : [ ]` skips iterator observation entirely.
 * Elision-only patterns (`[,]`, `[, ,]`) and nested-empty patterns
 * (`[[]]`, `[[], []]`) each perform one IteratorStep per top-level element
 * — they must NOT short-circuit when the parameter value is an iterable.
 *
 * Before #1432, `isPatternEmptyOnly` returned true for all "elements that
 * are themselves empty patterns" (#1158). That was a spec violation:
 *
 *   - `function f([,] = throwingIter) {}; f()` did NOT propagate the
 *     iterator's `.next()` throw (test262
 *     `dflt-ary-ptrn-elision-step-err.js`).
 *   - `function f([[]] = iter) {}` did NOT advance the iterator at all.
 *
 * After #1432, only the truly-empty `[]` short-circuits. All other
 * patterns route through the iterator materialization path so iterator
 * `.next()` errors propagate per spec.
 */
async function run(src: string): Promise<{ exports: Record<string, any> }> {
  const r = await compile(src, { fileName: "test.ts" });
  expect(r.success, JSON.stringify(r.errors)).toBe(true);
  const imports = buildImports(r.imports, undefined, r.stringPool) as any;
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  if (typeof imports.setExports === "function") imports.setExports(instance.exports);
  return { exports: instance.exports as Record<string, any> };
}

describe("#1432 — parameter destructuring iterator semantics", () => {
  it("[,] with throwing iterator: iterator step error propagates", async () => {
    // Direct equivalent of test262
    // language/expressions/function/dstr/dflt-ary-ptrn-elision-step-err.js
    const { exports } = await run(`
      let following = 0;
      function* gen(): any {
        throw new Error('iter-fail');
        following += 1;
      }
      const iter = gen();
      function f([,] = iter as any) {}
      export function test(): number {
        try {
          f();
          return -1;
        } catch (e: any) {
          if (e.message !== 'iter-fail') return -2;
          return 1;
        }
      }
    `);
    expect((exports.test as () => number)()).toBe(1);
  });

  it("truly-empty [] pattern: no iteration even for iterable values", async () => {
    // Spec: ArrayBindingPattern : [ ]  →  Return NormalCompletion(empty).
    // Per #1158, this remains the only short-circuit.
    let nextCalls = 0;
    const customIter: any = {
      [Symbol.iterator]() {
        return this;
      },
      next() {
        nextCalls += 1;
        return { done: true, value: undefined };
      },
    };
    const { exports } = await run(`
      function f([]: any) {}
      export function test(iter: any): number {
        f(iter);
        return 1;
      }
    `);
    nextCalls = 0;
    (exports.test as (iter: any) => number)(customIter);
    expect(nextCalls).toBe(0);
  });

  it("rest parameter with nested object destructuring: numeric + length keys", async () => {
    // From test262
    // language/expressions/function/dstr/ary-ptrn-rest-obj-prop-id.js
    const { exports } = await run(`
      function f([...{ 0: v, 1: w, 2: x, length: z }]: any = [7, 8, 9]): number {
        if (v !== 7) return -1;
        if (w !== 8) return -2;
        if (x !== 9) return -3;
        if (z !== 3) return -4;
        return 1;
      }
      export function test(): number { return f(); }
    `);
    expect((exports.test as () => number)()).toBe(1);
  });

  it("nested rest [[...x]] inside outer pattern: x is the rest array", async () => {
    // Variant of test262
    // language/expressions/function/dstr/dflt-ary-ptrn-elem-ary-rest-iter.js
    // (Array.isArray check stripped because that is a separate concern, #869.)
    const { exports } = await run(`
      function f([[...x] = []]: any = [[2, 1, 3]]): number {
        if (x.length !== 3) return -1;
        if (x[0] !== 2) return -2;
        if (x[1] !== 1) return -3;
        if (x[2] !== 3) return -4;
        return 1;
      }
      export function test(): number { return f(); }
    `);
    expect((exports.test as () => number)()).toBe(1);
  });

  it("default initializer fires only for undefined, not null/0/false/empty-string", async () => {
    // From test262 dstr/dflt-ary-ptrn-elem-id-init-skipped.js
    const { exports } = await run(`
      let initCount = 0;
      function counter(): any { initCount += 1; return -999; }

      function f([w = counter(), x = counter(), y = counter(), z = counter()]: any
                 = [null, 0, false, '']) {
        if (w !== null) return -1;
        if (x !== 0) return -2;
        if (y !== false) return -3;
        if (z !== '') return -4;
        if (initCount !== 0) return -5;
        return 1;
      }
      export function test(): number { return f(); }
    `);
    expect((exports.test as () => number)()).toBe(1);
  });

  it("default initializer DOES fire when slot is missing (OOB)", async () => {
    // [x = 42] with `[]` — slot 0 is out of bounds → undefined → default fires.
    const { exports } = await run(`
      function f([x = 42]: any = []): number {
        return x;
      }
      export function test(): number { return f(); }
    `);
    expect((exports.test as () => number)()).toBe(42);
  });

  it("[,] short-circuit is gone for iterables (regression guard for fix)", async () => {
    // After the #1432 narrowing of isPatternEmptyOnly, an iterable parameter
    // with `[,]` MUST flow through the materialization path. We don't pin
    // exact instructions here, just that the externref / iter machinery is
    // wired in (i.e. the compiler hasn't reverted to the spec-violating
    // short-circuit).
    const wat = await compileToWat(`
      function f([,]: any) {}
      export function test(iter: any): number { f(iter); return 0; }
    `);
    // The externref destructure path always references __extern_length or
    // __array_from_iter — at minimum one of those imports/calls must be
    // present once the short-circuit is removed.
    const hasIterMaterialization = /\$__array_from_iter|\$__extern_length|\$__extern_get_idx/.test(wat);
    expect(hasIterMaterialization).toBe(true);
  });

  it("truly-empty [] keeps the short-circuit (regression guard for #1158)", async () => {
    // Empty `[]` still skips iteration entirely. We expect no call to
    // __array_from_iter for a top-level empty pattern with iterable param.
    const wat = await compileToWat(`
      function f([]: any) {}
      export function test(iter: any): number { f(iter); return 0; }
    `);
    expect(wat).not.toMatch(/call\s+\$__array_from_iter/);
  });
});
