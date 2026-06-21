// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #2200 Phase 1 — Annex B B.3.3 block-level function declaration hoisting,
 * case-A cancellation guard.
 *
 * A `function F` nested in a *block* normally gets a web-compat var-scoped outer
 * binding (§B.3.3.1). But that outer binding is **cancelled** when an
 * intervening lexical (`let`/`const`/class) binding for `F` exists between the
 * block and the enclosing function/global scope, or `F` is a same-named param.
 * The compiler previously hoisted every block-nested `function` into the global
 * `funcMap` unconditionally, so a read of `F` in the enclosing scope resolved to
 * it instead of throwing the spec ReferenceError.
 *
 * Phase 1 records cancelled names + their declaring-block ranges during hoisting
 * and, at the read site, refuses funcMap/local resolution for a read OUTSIDE the
 * declaring block → the existing ReferenceError path fires. A read INSIDE the
 * block (the block-local function) still resolves. (Case B — the
 * uninitialized-then-init `typeof` lifecycle for *eligible* functions — is
 * Phase 2.)
 */

async function runNumber(src: string): Promise<number> {
  const r = await compile(src, { target: "standalone", nativeStrings: true });
  expect(r.success, r.success ? "" : r.errors.map((e) => e.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => number }).test();
}

describe("#2200 Phase 1 — Annex B B.3.3 case-A cancellation", () => {
  it("a let-shadow cancels the outer binding → reading F outside the block throws ReferenceError", async () => {
    const out = await runNumber(`
      export function test(): number {
        let threw = 0;
        try { (f as any); } catch (e) { threw = (e instanceof ReferenceError) ? 1 : 0; }
        { let f = 123; { function f() {} } }
        return threw;
      }`);
    expect(out).toBe(1);
  });

  it("the cancelled function is still callable INSIDE its declaring block", async () => {
    const out = await runNumber(`
      export function test(): number {
        let r = 0;
        { let f = 1; { function f() { return 7; } r = f(); } }
        return r;
      }`);
    expect(out).toBe(7);
  });

  it("a same-named parameter cancels the Annex B outer binding (param value wins, no block-fn)", async () => {
    // §B.3.3: a param named `p` cancels the block-nested function's outer
    // var-binding. The param remains a valid binding, so reading `p` in the
    // function body returns the PARAMETER value (5), NOT the block function and
    // NOT a ReferenceError.
    const out = await runNumber(`
      function outer(p: number): number {
        { if (true) function p() {} }
        return p;
      }
      export function test(): number { return outer(5); }`);
    expect(out).toBe(5);
  });

  it("a block-nested function with NO shadow is unaffected (no spurious throw, callable in-block)", async () => {
    const out = await runNumber(`
      export function test(): number {
        let r = 0;
        { function h() { return 9; } r = h(); }
        return r;
      }`);
    expect(out).toBe(9);
  });

  it("a direct function-body declaration is unaffected (normal hoist)", async () => {
    const out = await runNumber(`
      export function test(): number { function k() { return 11; } return k(); }`);
    expect(out).toBe(11);
  });
});
