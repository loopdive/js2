// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1702 — residual strict-mode `this` regressions (the #873 / #895 follow-up).
 *
 * A rigorous baseline-diff after #895 found 66 test262 cases still failing on
 * the SAME strict-`this` root cause #895 only partially fixed, in two shapes:
 *
 *  1. `language/function-code/10.4.3-1-*-s` (34 cases) — in strict code, a
 *     function invoked with no receiver must see `this === undefined`. The
 *     failing form is the test262 wrapper turning `var f1 = function () { … }`
 *     into a LOCAL closure inside `export function test()`. That outer
 *     function-expression body carries `readsCurrentThis: true` (set on every
 *     lifted closure so a host `toJSON`/replacer dispatch can observe the
 *     installed receiver), but for a *direct* `f1()` call `__current_this` is
 *     never installed and holds its `ref.null.extern` initial value. The raw
 *     `global.get` surfaced JS `null`, so `typeof this` was `"object"` and
 *     `this === undefined` was `false`.
 *
 *  2. `language/{expressions,statements}/class/dstr/*meth-*ary-elision-iter`
 *     (32 cases) — class method bodies are always strict. A nested
 *     `function inner() { … }` declared inside a method was lifted with the
 *     method's `this` (the instance) threaded in as a capture param, so
 *     `inner()`'s `this` was the instance instead of the spec `undefined`.
 *     A `FunctionDeclaration` establishes its OWN `this` binding
 *     (§10.2.1.1) — it never lexically captures the enclosing `this` the
 *     way an arrow does.
 *
 * Fix (additive to #895, never widening which bodies read the global):
 *  - `expressions.ts` ThisKeyword: null-guard the `__current_this` read so the
 *    direct-call path yields `undefined`; only a host-installed (non-null)
 *    receiver flows through.
 *  - `nested-declarations.ts`: skip `this`/`super` when collecting captures for
 *    a nested `FunctionDeclaration`.
 */
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(src: string): Promise<unknown> {
  const r = await compile(src);
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  const imports = buildImports(r.imports, undefined, r.stringPool) as Record<string, unknown> & {
    setExports?: (e: Record<string, Function>) => void;
  };
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  if (typeof imports.setExports === "function") {
    imports.setExports(instance.exports as Record<string, Function>);
  }
  return (instance.exports as Record<string, () => unknown>).test?.();
}

describe("#1702 — residual strict-mode `this` (10.4.3-1-*-s + class-method shapes)", () => {
  it("shape 1: strict function-expression sees `this === undefined` (10.4.3-1-30-s)", async () => {
    // Exact test262 wrap of the 10.4.3-1-30-s pattern: onlyStrict prepends
    // "use strict", the body becomes a local inside `export function test()`.
    expect(
      await run(`"use strict";
        export function test(): number {
          var f1 = function () {
            function f() { return typeof this; }
            return (f() === "undefined") && ((typeof this) === "undefined");
          };
          if (!(f1())) { return -1; }
          return 1;
        }`),
    ).toBe(1);
  });

  it("shape 1: strict function-expression `typeof this` is 'undefined', not 'object'", async () => {
    expect(
      await run(`"use strict";
        export function test(): string {
          var f1 = function () { return typeof this; };
          return f1();
        }`),
    ).toBe("undefined");
  });

  it("shape 1: strict function-expression `this === undefined` is true (not null)", async () => {
    expect(
      await run(`"use strict";
        export function test(): boolean {
          var f1 = function () { return this === undefined; };
          return f1();
        }`),
    ).toBe(1);
  });

  it("shape 2: nested fn-decl in a class method sees `this === undefined`", async () => {
    expect(
      await run(`
        export function test(): string {
          class C {
            m(): string {
              function inner(): string { return typeof this; }
              return inner();
            }
          }
          return new C().m();
        }`),
    ).toBe("undefined");
  });

  it("shape 2: the class method's own `this` is still the instance (not regressed)", async () => {
    expect(
      await run(`
        export function test(): string {
          class C { m(): string { return typeof this; } }
          return new C().m();
        }`),
    ).toBe("object");
  });

  it("shape 2: elision-iter destructuring param method advances the iterator exactly once", async () => {
    // The class/dstr meth-ary-elision-iter symptom: the method must run once
    // (callCount === 1). The strict-`this` corruption inside the body
    // previously over-counted; with the fix the body runs cleanly.
    expect(
      await run(`
        let callCount = 0;
        class C { m([, x]: any) { callCount += 1; return x; } }
        function* g() { yield 1; yield 2; yield 3; }
        export function test(): number {
          new C().m(g());
          return callCount;
        }`),
    ).toBe(1);
  });

  it("nested fn-decl `this` inside a plain strict function is also undefined", async () => {
    expect(
      await run(`"use strict";
        export function test(): string {
          function outer(): string {
            function inner(): string { return typeof this; }
            return inner();
          }
          return outer();
        }`),
    ).toBe("undefined");
  });
});
