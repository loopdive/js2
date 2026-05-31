// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Regression guard for the #1636-S1 `__current_this` over-read.
 *
 * #1636-S1 added a `__current_this` module global so that closures dispatched
 * from the host via `__call_fn_method_N` (a value's `toJSON`, a
 * `JSON.stringify` replacer) observe the host-supplied receiver. The first cut
 * gated the `ThisKeyword` fallback on `ctx.currentThisGlobalIdx >= 0`, but
 * `ensureCurrentThisGlobal` runs eagerly for every module that emits *any*
 * closure — so the condition was true module-wide. That made EVERY `this` in a
 * directly-called named function read the global's `ref.null.extern` initial
 * value (surfacing as `null`) instead of the spec-correct `undefined` (strict)
 * / globalObject (sloppy). It regressed 171 test262 cases in
 * `language/function-code/10.4.3-1-*` and `built-ins/Array/prototype/*`.
 *
 * The fix narrows the fallback to closure bodies that can actually be
 * dispatched through `__call_fn_method_N` (`fctx.readsCurrentThis`). A named
 * function declaration / method / constructor is called directly via `call $f`
 * and never has `__current_this` installed for it, so it must NOT read the
 * global. These tests pin both halves of the invariant:
 *   - a directly-called strict named function sees `this === undefined`;
 *   - the #1636-S1 host-dispatch path still threads the receiver (covered in
 *     `issue-1636-s1-tojson-this.test.ts`).
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function run(src: string): Promise<unknown> {
  const r = (await compile(src, { fileName: "test.ts" })) as ReturnType<typeof compile> & {
    importObject: WebAssembly.Imports;
  };
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, r.importObject);
  return (instance.exports as Record<string, () => unknown>).main?.();
}

describe("#1636-S1 regression — direct-call `this` must not read __current_this", () => {
  it("strict named function: `this === undefined` in a closure-emitting module (10.4.3-1-7-s)", async () => {
    // Exporting the closure `cb` forces `ensureCurrentThisGlobal` to register
    // `__current_this` (the precondition that made the buggy gate fire), yet
    // `f` is called directly via `call $f` and must NOT read that global.
    expect(
      await run(`
        function f() { "use strict"; return this === undefined; }
        const cb = function () { return 0; };
        export function getCb(): any { return cb; }
        export function main(): boolean { return f(); }
      `),
    ).toBe(1);
  });

  it("strict named function: `this` resolves to undefined, not the global's null (the regression value)", async () => {
    expect(
      await run(`
        function f() { "use strict"; return this; }
        const cb = function () { return 0; };
        export function getCb(): any { return cb; }
        export function main(): boolean { return f() === undefined; }
      `),
    ).toBe(1);
  });

  it("strict global function directive prologue (14.1-1-s)", async () => {
    expect(
      await run(`
        "use strict";
        function testcase(): boolean { return this === undefined; }
        export function main(): boolean { return testcase(); }
      `),
    ).toBe(1);
  });
});
