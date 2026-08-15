// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4466 — the three independent codegen defects #4507 landed on `main`, each
// pinned by the SHAPE of the test262 file it broke.
//
// #4507 ("bound upstream compilation and preserve class object shapes") went
// through the merge queue while its own `merge_group` run was reporting these
// as pass→fail. It merged anyway because the NEXT queue group — which already
// contained it — diffed against a baseline that had moved, and so read 0
// regressions. The failures were real and deterministic on `main`.
//
// SHAPE IS LOAD-BEARING HERE. A first cut of this file used the obvious
// simplification of each case (`const o = { m({} = {}) {} }; o.m()`, a direct
// `this.#priv()`, a spread of a plain literal) and every assertion PASSED
// against the unfixed compiler — the simplified sources never reach the paths
// that break. Only root cause (3) reduces to a source that genuinely
// reproduces; see the note below the helper for why (1) and (2) are covered by
// their test262 files instead. Before changing the source below, re-run it
// against the pre-fix compiler and confirm it still fails.
//
// The three root causes share nothing but their author:
//
//  1. `closed-method-dispatch.ts` relaxed the closed-method arity gate to admit
//     under-applied calls, but the arm it builds can only stand in for an
//     omitted formal whose default is a CONSTANT (or an f64, which has an
//     absence sentinel the callee's prologue recognizes). For any other lane it
//     pushes a typed zero/null the callee cannot tell from a real argument, so
//     the default never runs and the callee destructures a null.
//     → `language/expressions/object/dstr/{,gen-,async-gen-}meth-dflt-obj-ptrn-empty.js`
//  2. `literals.ts` dropped the `native-first` gate on spread-source
//     materialization, putting the JS-host lane on an eager field walk that
//     snapshots the source before `__object_assign` — changing what a getter
//     that mutates the outer object mid-spread observes.
//     → `language/expressions/{array,new,super}/spread-obj-manipulate-outter-obj-in-getter.js`
//  3. `method-trampolines.ts` re-coerced the receiver on the finalize REBUILD
//     path (aliasing `tFctx.body` to the trampoline body to do it), corrupting
//     the cached private-method trampoline.
//     → `language/statements/class/elements/super-access-inside-a-private-method.js`
//
// Assertions are made INSIDE the module and reported as a number, so nothing
// depends on marshalling a string or object back across the JS boundary.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

/** Compile + run `test()` on the default JS-host (gc) lane — CI's js-host shard. */
async function runHost(src: string): Promise<number> {
  const r = await compile(src);
  expect(r.success, r.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  imports.setExports?.(instance.exports as Record<string, Function>);
  return (instance.exports as { test: () => number }).test();
}

// NOTE — root causes (1) and (2) have NO unit test here, deliberately.
//
// Every reduced TypeScript source tried for them either failed for an
// unrelated reason (`delete` on a typed record) or PASSED against the UNFIXED
// compiler — i.e. it never reached the path that broke. For (1) that is the
// closed-method dispatcher (`__call_m_<name>_<arity>`), which a reduced source
// does not engage: shape-erased receivers, two same-named methods on
// differently-shaped literals, and generator methods were all tried and all
// passed pre-fix. Shipping those would have banked a test that proves nothing
// and reads as armor.
//
// The coverage for (1) and (2) is the test262 files themselves, which CI's
// js-host shard runs on every merge_group. Each was verified locally
// pass (pre-#4507) → fail (on main) → pass (with this fix):
//   test262/test/language/expressions/object/dstr/meth-dflt-obj-ptrn-empty.js
//   test262/test/language/expressions/object/dstr/gen-meth-dflt-obj-ptrn-empty.js
//   test262/test/language/expressions/object/dstr/async-gen-meth-dflt-obj-ptrn-empty.js
//   test262/test/language/expressions/array/spread-obj-manipulate-outter-obj-in-getter.js
//   test262/test/language/expressions/new/spread-obj-manipulate-outter-obj-in-getter.js
//   test262/test/language/expressions/super/call-spread-obj-manipulate-outter-obj-in-getter.js
//
// Their protection is restored once this lands: three of them are currently
// banked as `fail` in the promoted baseline (the regression gate cannot flag
// what it already records as failing), and the next promote after this merge
// puts them back to `pass`.

// NOTE — root cause (2) has NO unit test here, deliberately. Every reduced
// TypeScript source I could write either failed for an unrelated reason
// (`delete` on a typed record) or passed against the UNFIXED compiler, i.e. it
// did not reach the path that broke. Rather than ship a test that proves
// nothing, the coverage for (2) is the three test262 files themselves, which
// CI's js-host shard runs on every merge_group:
//   test262/test/language/expressions/array/spread-obj-manipulate-outter-obj-in-getter.js
//   test262/test/language/expressions/new/spread-obj-manipulate-outter-obj-in-getter.js
//   test262/test/language/expressions/super/call-spread-obj-manipulate-outter-obj-in-getter.js
// All three were verified pass→fail→pass across the fix locally.

describe("#4466 (3) cached private-method trampoline keeps a live receiver", () => {
  it("calls an EXTRACTED private method that reads super", async () => {
    // `super-access-inside-a-private-method.js`: the private method is reached
    // as a VALUE through `.call(o)`, which routes via the cached trampoline and
    // `__call_fn_method_0`. Pre-fix this gave "dereferencing a null pointer" in
    // `__obj_meth_tramp_*_cached`. A direct `this.#m()` does NOT reproduce it.
    expect(
      await runHost(
        `class A {
           method(): string {
             return "Test262";
           }
         }
         class C extends A {
           #m(): string {
             return super.method();
           }
           access(o: unknown): string {
             return this.#m.call(o as C);
           }
         }
         export function test(): number {
           const c = new C();
           if (c.access(c) !== "Test262") return 1;
           if (c.access({}) !== "Test262") return 2;
           return 0;
         }`,
      ),
    ).toBe(0);
  });
});
