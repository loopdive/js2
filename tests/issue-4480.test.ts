// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4480 S1) §13.2 steps 16-18 — every user function owns a `.prototype`
// object, and that object's `constructor` points back at the function.
//
// Measured on this branch's base `793b5c0e1` with `--target standalone`
// (runs executed for this issue, `tests/test262-runner.ts` standalone lane):
//
//   | shape                                              | base      | spec     |
//   | -------------------------------------------------- | --------- | -------- |
//   | `function F(){}; typeof F.prototype`                | undefined | "object" |
//   | `function F(){}; F.prototype === undefined`         | true      | false    |
//   | `function F(){}; F.prototype.q = 7; F.prototype.q`  | undefined | 7        |
//   | `function F(){}; F.prototype = p; F.prototype === p`| false     | true     |
//   | `function F(){}; var i=new F(); F.prototype.ctor===F| false     | true     |
//
// Row 4 is the one worth staring at: the base did not merely LACK a prototype
// object for a never-constructed fnctor, it answered a DIFFERENT object than
// the one the program had just assigned. That is why the fix is a widening of
// the ONE carrier (`ctx.fnctorPrototypeObject`) rather than a new one — read
// and write resolve through the same `resolveUserFnctorName`, so they cannot
// drift apart.
//
// The widening is deliberately bounded to fnctors with NO `new F()` site in the
// module (plus the pre-existing escape-gate-approved set). See the issue file's
// design section: the hazard the #2660 S2 reconstruct-gate exists for is a
// split brain between `F.prototype` and the object `new F()` links instances
// to, and a constructor that is never constructed has no instance to disagree
// with. `it.fails` pins below record the shapes that remain on the old answer.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/** Compile `body` as the `test()` export and run it host-free. */
async function runStandalone(body: string): Promise<number> {
  const source = `export function test(): number { ${body} }`;
  const result = await compile(source, {
    allowJs: true,
    fileName: "issue-4480.ts",
    skipSemanticDiagnostics: true,
    target: "standalone",
  });
  expect(result.success, result.errors.map((error) => `L${error.line}: ${error.message}`).join("\n")).toBe(true);
  // Host-free: a standalone module must instantiate against an empty import
  // object. If this ever needs a host bridge, the arms leaked an import.
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { test(): number }).test();
}

describe("#4480 S1 — a never-constructed function still owns its `.prototype`", () => {
  it("materializes an object for a plain function declaration", async () => {
    expect(await runStandalone(`function F(){} return typeof F.prototype === "object" ? 1 : 0;`)).toBe(1);
  });

  it("answers the `=== undefined` observation, not just `typeof`", async () => {
    // The `=== undefined` route is `property-nullish-read.ts`, which bypasses
    // `property-access-dispatch.ts` entirely. Until this issue the two routes
    // disagreed IN THE SAME MODULE: `typeof F.prototype` said `"object"` while
    // `F.prototype === undefined` said `true`. That split is exactly what
    // `S13.2_A1_T1` asserts, and it is why the arm had to be added on BOTH
    // routes rather than only the dispatcher.
    expect(await runStandalone(`function F(){} return F.prototype === undefined ? 0 : 1;`)).toBe(1);
  });

  it("keeps ONE object identity across repeated reads", async () => {
    expect(await runStandalone(`function F(){} return F.prototype === F.prototype ? 1 : 0;`)).toBe(1);
  });

  it("stores a per-property write and reads it back", async () => {
    expect(await runStandalone(`function F(){} F.prototype.q = 7; return F.prototype.q === 7 ? 1 : 0;`)).toBe(1);
  });

  it("preserves the IDENTITY of a whole-prototype reassignment", async () => {
    // Base answered `false` here — a WRONG object, not a missing one.
    expect(await runStandalone(`function F(){} var p = {}; F.prototype = p; return F.prototype === p ? 1 : 0;`)).toBe(
      1,
    );
  });

  it("carries a write performed from another function body", async () => {
    expect(
      await runStandalone(
        `function F(){} function s(){ F.prototype.tag = 42; } s(); return F.prototype.tag === 42 ? 1 : 0;`,
      ),
    ).toBe(1);
  });
});

describe("#4480 S1 — the §13.2 step 10 `constructor` back-ref", () => {
  it("points back at the function itself, by IDENTITY", async () => {
    // The value must be the SAME object an ordinary `F` identifier read yields
    // (the `__fn_closure_<name>` singleton), not merely a function with the
    // same behaviour — which is why the install declines wherever that
    // singleton is not provably what the identifier read produces.
    expect(await runStandalone(`function F(){} return F.prototype.constructor === F ? 1 : 0;`)).toBe(1);
  });

  it("is an OWN property of the prototype object", async () => {
    expect(await runStandalone(`function F(){} return F.prototype.hasOwnProperty("constructor") ? 1 : 0;`)).toBe(1);
  });

  it("is NOT enumerable (§13.2 step 10 {DontEnum})", async () => {
    // `S13.2_A4_T1` CHECK#3 asserts this directly with a `for-in`. An
    // enumerable `constructor` would ALSO leak into every `Object.keys` /
    // `JSON.stringify` of an instance, so this is load-bearing well beyond the
    // one row that names it.
    expect(
      await runStandalone(
        `function F(){} var seen = 0; for (var p in F.prototype) { if (p === "constructor") seen = 1; } return seen === 0 ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("agrees with the instance link for a constructed fnctor", async () => {
    // The pre-existing reconstruct path already linked instances; what was
    // missing there was only the back-ref. Asserted together so the two halves
    // cannot drift.
    expect(
      await runStandalone(
        `function F(){} var i = new F(); return (F.prototype.constructor === F) && (Object.getPrototypeOf(i) === F.prototype) ? 1 : 0;`,
      ),
    ).toBe(1);
  });
});

describe("#4480 S2 — a `new F()` instance reports the SAME object `F.prototype` reads", () => {
  // Measured on this branch with S1 alone (probe `.tmp/probe3.mts`, runs
  // executed for this issue): every row below answered `0`. The instance does
  // not lower to an `$Object` — it lowers to the bespoke `$__fnctor_<F>` struct,
  // which has no `$proto` field for the native `__getPrototypeOf` walk to read.
  // So `F.prototype` answered the S1 global while `Object.getPrototypeOf(i)`
  // answered something else and the module contradicted ITSELF. S2 is that
  // repair, not a widening.
  it("answers `Object.getPrototypeOf(i)` for a `this`-assigning constructor", async () => {
    expect(
      await runStandalone(
        `function F(){ this.x = 1; } var i = new F(); return Object.getPrototypeOf(i) === F.prototype ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("answers it for a direct `new F()` argument, not just a binding", async () => {
    expect(
      await runStandalone(`function F(){ this.x = 1; } return Object.getPrototypeOf(new F()) === F.prototype ? 1 : 0;`),
    ).toBe(1);
  });

  it("agrees with the `constructor` back-ref installed by S1", async () => {
    // The two halves are asserted together so they cannot drift: the object
    // reached through the instance must be the object carrying `constructor`.
    expect(
      await runStandalone(
        `function F(){ this.x = 1; } var i = new F(); return Object.getPrototypeOf(i).constructor === F ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("leaves `Object.getPrototypeOf(F)` itself alone", async () => {
    // The arm sits AFTER the top-level-function arm, so the FUNCTION still
    // reports %Function.prototype%, not its own `.prototype` object.
    expect(
      await runStandalone(`function F(){ this.x = 1; } return Object.getPrototypeOf(F) === F.prototype ? 0 : 1;`),
    ).toBe(1);
  });
});

describe("#4480 — measured residuals (see the issue file's Residuals section)", () => {
  it.fails("R5: S2 declines under a whole `F.prototype = p` reassignment (condition 2)", async () => {
    // Condition 2 in fnctor-instance-prototype.ts: with a reassignment present
    // the single mutable global no longer models "the value captured at
    // construction", so the arm must not answer — and it does not. The result
    // is therefore still the pre-S2 answer (absent), NOT the spec one. Pinned
    // as an `it.fails` rather than dropped, because the guard is exactly what
    // stops the arm from becoming wrong on `S13.2.2_A1_T1`-shaped modules, and
    // a future slice that re-points the slot per construction site should flip
    // this row rather than delete it.
    expect(
      await runStandalone(
        `function F(){ this.x = 1; } var p = {}; F.prototype = p; var i = new F(); return Object.getPrototypeOf(i) === p ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it.fails("R4: `F.prototype.isPrototypeOf(i)` — blocked by the escape gate, not the walk", async () => {
    // Instrumented compile (evidence in native-is-prototype-of.ts): writing the
    // call is itself a dynamic method use on `F`'s prototype, so the #2660
    // escape gate demotes `F` and `resolveUserFnctorName` declines — the same
    // module reports `resolve=F` when the read point is `Object.getPrototypeOf`
    // instead. A `ref.test (ref $__fnctor_F)` arm was written and measured to be
    // unreachable, so it was removed rather than shipped as dead code.
    expect(
      await runStandalone(`function F(){ this.x = 1; } var i = new F(); return F.prototype.isPrototypeOf(i) ? 1 : 0;`),
    ).toBe(1);
  });

  it.fails("R1: a fnctor that IS constructed but is not escape-gate-approved", async () => {
    // `var H = function(){}; new H()` — the `new` site is classified
    // `keep-typed`/`keep-static`, so its instances live in a `__fnctor_H`
    // struct rather than an `$Object`. Admitting H here would make
    // `H.prototype` an object the instances are NOT linked to. Deliberately
    // still `undefined`.
    expect(
      await runStandalone(`var H = function(){}; var h = new H(); return typeof H.prototype === "object" ? 1 : 0;`),
    ).toBe(1);
  });

  it.fails("R2: `constructor` on a `var F = function(){}` prototype", async () => {
    // The back-ref install needs the `__fn_closure_<name>` singleton, which
    // this shape does not go through; the read is answered by the pre-existing
    // plain-object `.constructor` fold (`Object`) instead. `S13.2_A4_T2`
    // CHECK#2.
    expect(await runStandalone(`var G = function(){}; return G.prototype.constructor === G ? 1 : 0;`)).toBe(1);
  });

  it.fails("R3: a FUNCTION-valued prototype cannot be linked to instances", async () => {
    // `S13.2.2_A1_T1`. `$Object.$proto` is typed `(ref null $Object)`, so a
    // closure struct simply cannot be stored in it — this is a representation
    // limit, not a missing arm, and widening the field type perturbs the
    // canonical rec-group boundary (#2514).
    expect(
      await runStandalone(
        `function P(){} P.type = 1; function F(){} F.prototype = P; var m = new F(); return P.isPrototypeOf(m) ? 1 : 0;`,
      ),
    ).toBe(1);
  });
});
