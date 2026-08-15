// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4460) A static member read taken directly off a class EXPRESSION —
// `class { static m() {} }.m` — evaluated to `null` at runtime while the
// checker-driven folds still answered `typeof === "function"` and `.length ===
// 0`. Measured on this branch's base with `--target standalone` (the real
// `runTest262File` via `.tmp/run-one.mts`):
//
//   | file                                                        | base | fixed |
//   | ----------------------------------------------------------- | ---- | ----- |
//   | `language/expressions/class/static-method-length-dflt.js`   | fail | pass  |
//   | `language/statements/class/static-method-length-dflt.js`    | pass | pass  |
//
// The declaration twin passed because only the IDENTIFIER-receiver band in
// `property-access-dispatch.ts` carried the static-member emission; an in-place
// class expression matched no arm and fell through to the generic dynamic
// member get, which emits `ref.null.extern`.
//
// Every test below pins the EXPRESSION form against the DECLARATION form in the
// same module wherever both exist, because the defect was a DISAGREEMENT
// between two carriers, not a missing value — asserting the expression form
// alone would have passed the whole time on `typeof`.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/** Compile `body` as the `test()` export and run it host-free. */
async function runStandalone(body: string): Promise<number> {
  const source = `export function test(): number { ${body} }`;
  const result = await compile(source, {
    allowJs: true,
    fileName: "issue-4460.ts",
    skipSemanticDiagnostics: true,
    target: "standalone",
  });
  expect(result.success, result.errors.map((error) => `L${error.line}: ${error.message}`).join("\n")).toBe(true);
  // Host-free: a standalone module must instantiate against an empty import
  // object. If this ever needs a host bridge, the arm leaked an import.
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { test(): number }).test();
}

describe("#4460 — static member read off a class EXPRESSION", () => {
  it("yields a non-null value, not `ref.null.extern`", async () => {
    // The original symptom, stated exactly: `=== null` was TRUE while `typeof`
    // said "function".
    expect(
      await runStandalone(`
        var m1 = class { static m(x = 42) {} }.m;
        return (m1 !== null && m1 !== undefined) ? 1 : 0;`),
    ).toBe(1);
  });

  it("yields a CALLABLE function value", async () => {
    // Non-null is not enough — the null carrier also threw "Cannot access
    // property on null or undefined" at the call site.
    expect(
      await runStandalone(`
        var f = class { static m(x) { return 7; } }.m;
        return f(1);`),
    ).toBe(7);
  });

  it("agrees with the typeof/length folds it used to contradict", async () => {
    // The compile-time answer was already "function"/0; this pins the RUNTIME
    // value to the same answer, which is the whole bug.
    expect(
      await runStandalone(`
        var m1 = class { static m(x = 42) {} }.m;
        var k = "length";
        return (typeof m1 === "function" && m1[k] === 0) ? 1 : 0;`),
    ).toBe(1);
  });

  it("matches the DECLARATION form on the same metadata", async () => {
    // The declaration twin was green throughout. Asserting the two forms
    // against each other is what makes a future divergence visible regardless
    // of which side moves.
    expect(
      await runStandalone(`
        class C { static m(x = 42) {} }
        var fromDecl = C.m;
        var fromExpr = class { static m(x = 42) {} }.m;
        var kl = "length", kn = "name";
        return (fromExpr[kl] === fromDecl[kl] && fromExpr[kn] === fromDecl[kn]) ? 1 : 0;`),
    ).toBe(1);
  });

  it("counts §15.1.5 `length` per the test262 static-method-length-dflt shapes", async () => {
    // The four shapes of `language/expressions/class/static-method-length-dflt.js`,
    // in one module: 0, 0, 1, 1 → 0*1000 + 0*100 + 1*10 + 1.
    expect(
      await runStandalone(`
        var k = "length";
        var m1 = class { static m(x = 42) {} }.m;
        var m2 = class { static m(x = 42, y) {} }.m;
        var m3 = class { static m(x, y = 42) {} }.m;
        var m4 = class { static m(x, y = 42, z) {} }.m;
        return m1[k] * 1000 + m2[k] * 100 + m3[k] * 10 + m4[k];`),
    ).toBe(11);
  });

  it("reads a static FIELD off a class expression", async () => {
    // Static fields resolve through a different arm (`ctx.staticProps` global)
    // than static methods (`emitFuncRefAsClosure`); both are now reachable from
    // an expression receiver.
    expect(
      await runStandalone(`
        var v = class { static f = 41; }.f;
        return v + 1;`),
    ).toBe(42);
  });

  it("routes `.prototype` off a class expression to the SAME answer as a declaration", async () => {
    // NOT a claim that the answer is right. Measured on this tree (standalone,
    // `.tmp/probe2.mts`): `class C { m(){} } C.prototype` and
    // `var C = class { m(){} }; C.prototype` BOTH read as nullish, i.e. the
    // `.prototype` value read is a pre-existing gap this issue does not touch
    // (recorded as a residual on #4460). What is pinned here is that the
    // expression receiver reaches the same emission the identifier receiver
    // does — if the declaration form is fixed and the expression form is not,
    // this flips.
    expect(
      await runStandalone(`
        class D { m() {} }
        var fromDecl = D.prototype;
        var fromExpr = class { m() {} }.prototype;
        var declNullish = (fromDecl === null || fromDecl === undefined) ? 1 : 0;
        var exprNullish = (fromExpr === null || fromExpr === undefined) ? 1 : 0;
        return declNullish === exprNullish ? 1 : 0;`),
    ).toBe(1);
  });

  it("keeps a NAMED class expression's static read working", async () => {
    // A named class expression is registered under a synthetic name derived
    // from its own name, a different key than the anonymous counter.
    expect(
      await runStandalone(`
        var f = class Named { static m(x) { return 5; } }.m;
        return f(0);`),
    ).toBe(5);
  });

  it("does not disturb the `var C = class {}` indirection", async () => {
    // The pre-existing identifier band resolves this through
    // `ctx.classExprNameMap`, and the fix EXTRACTED that band's body — so this
    // is the direct guard against the extraction changing it. The read-then-call
    // shape is used deliberately: the fused `C.m(0)` form on a class-expression-
    // bound identifier answers 0 on this tree with or without the fix (measured,
    // `.tmp/probe2.mts`) — a separate call-dispatch gap, recorded as a residual.
    expect(
      await runStandalone(`
        var C = class { static m(x) { return 9; } };
        var f = C.m;
        return f(0);`),
    ).toBe(9);
  });
});
