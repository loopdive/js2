// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4623) `<ordinary receiver>.isPrototypeOf(V)` — §20.1.3.4 — answered wrong on
// BOTH lanes, in two different ways, for every receiver that is not written
// syntactically as `<Something>.prototype`:
//
//   | lane       | measured before | why                                        |
//   | ---------- | --------------- | ------------------------------------------ |
//   | standalone | `false`         | `compileTailDispatch`'s ref.test-guarded    |
//   |            |                 | generic closure dispatch, else-branch null  |
//   | JS host    | `undefined`     | the graceful `ref.null.extern` fallback     |
//
// Both are pinned here in BOTH lanes, because a one-lane pin would not have
// caught either half: the fix is one arm placed where the two lanes converge
// (`is-prototype-of-call-arm.ts`), and each lane reached that point from a
// different upstream arm.
//
// The second block pins §20.1.3.4's STEP ORDER on the borrowed spelling
// `Object.prototype.isPrototypeOf.call(<this>, V)`: step 1 answers `false` for a
// non-object `V` *before* step 2's `ToObject(this)` can throw. Both directions
// are pinned, because the fix (#4623, `builtin-prototype-brand.ts`) is exactly
// the conditional that separates them — a receiver-only gate would throw on
// both and break the row that passes today.
//
// No module here mints code from a string, so there is no runtime-eval tier arm:
// every case runs identically under `JS2WASM_EVAL_ENGINE=interpreter`.
import { describe, expect, it } from "vitest";
import { buildImports, compile, instantiateWasm } from "../src/index.js";

/** Compile+run under `--target standalone` (host-free) and return `test()`. */
async function runStandalone(prelude: string, verdict: string): Promise<number> {
  const result = await compile(`${prelude}\nexport function test(): number { return ${verdict}; }`, {
    allowJs: true,
    fileName: "issue-4623.ts",
    skipSemanticDiagnostics: true,
    target: "standalone",
  });
  expect(result.success, result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary), "module failed WebAssembly.validate").toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { test(): number }).test();
}

/** The JS-host lane twin: same source, host imports, same verdict. */
async function runHost(prelude: string, verdict: string): Promise<number> {
  const result = await compile(`${prelude}\nexport function test(): number { return ${verdict}; }`, {
    allowJs: true,
    fileName: "issue-4623.ts",
    skipSemanticDiagnostics: true,
  });
  expect(result.success, result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary), "module failed WebAssembly.validate").toBe(true);
  const imports = buildImports(result.imports, {}, result.stringPool);
  const { instance } = await instantiateWasm(result.binary, imports.env, imports.string_constants);
  imports.setInstance?.(instance);
  return (instance.exports as { test(): number }).test();
}

/** Run the same probe on both lanes and return `[standalone, host]`. */
async function runBothLanes(prelude: string, verdict: string): Promise<[number, number]> {
  return [await runStandalone(prelude, verdict), await runHost(prelude, verdict)];
}

const CHAIN = `
  var P = { q: 1 };
  var o = Object.create(P);
  var deep = Object.create(o);
  var unrelated = { r: 2 };
`;

describe("#4623 plain-object receiver isPrototypeOf", () => {
  it("answers true for a direct Object.create link — both lanes", async () => {
    // The issue's probe verbatim. Measured before: standalone `false`, host
    // `undefined`.
    expect(await runBothLanes(CHAIN, "P.isPrototypeOf(o) === true ? 1 : 0")).toEqual([1, 1]);
  });

  it("answers true through a two-level chain — both lanes", async () => {
    expect(await runBothLanes(CHAIN, "P.isPrototypeOf(deep) === true ? 1 : 0")).toEqual([1, 1]);
  });

  it("answers false for an object that is NOT in the chain — both lanes", async () => {
    // The negative control: the arm must answer the WALK, not "true".
    expect(await runBothLanes(CHAIN, "P.isPrototypeOf(unrelated) === false ? 1 : 0")).toEqual([1, 1]);
  });

  it("answers false for a primitive argument (§20.1.3.4 step 1) — both lanes", async () => {
    expect(await runBothLanes(CHAIN, "P.isPrototypeOf(5) === false ? 1 : 0")).toEqual([1, 1]);
  });

  it("answers false for a null argument — both lanes", async () => {
    expect(await runBothLanes(CHAIN, "P.isPrototypeOf(null) === false ? 1 : 0")).toEqual([1, 1]);
  });

  it("answers a BOOLEAN, not the number 1 — both lanes", async () => {
    // The `boolean` brand on the i32 result. Without it `r === true` would be
    // `1 !== true` and every row above would still read as a failure at the
    // call site that consumes the value.
    expect(await runBothLanes(CHAIN, "typeof P.isPrototypeOf(o) === 'boolean' ? 1 : 0")).toEqual([1, 1]);
  });

  it("keeps the bracket spelling on the same answer — both lanes", async () => {
    expect(await runBothLanes(CHAIN, "P['isPrototypeOf'](o) === true ? 1 : 0")).toEqual([1, 1]);
  });

  it("does NOT fold when the program installs its own isPrototypeOf", async () => {
    // The override control. The arm declines (`sourceHasMethodOverride`), so the
    // program's own method is what runs — the intrinsic must not shadow it.
    expect(
      await runStandalone(
        `
        var P = { q: 1 };
        var o = Object.create(P);
        P.isPrototypeOf = function () { return 7; };
      `,
        "P.isPrototypeOf(o) === 7 ? 1 : 0",
      ),
    ).toBe(1);
  });
});

describe("#4623 borrowed isPrototypeOf — §20.1.3.4 step order (standalone)", () => {
  it("throws a catchable TypeError for a nullish `this` with an OBJECT argument", async () => {
    // Step 1 does not apply (V is an object), so step 2's ToObject(null) throws.
    // `assert.throws(TypeError, …)` in test262 needs it CATCHABLE, so the probe
    // catches it rather than letting a trap kill the module.
    expect(
      await runStandalone(
        `
        var t = 0;
        try { Object.prototype.isPrototypeOf.call(null, function () {}); }
        catch (e) { t = (e instanceof TypeError) ? 1 : 2; }
      `,
        "t",
      ),
    ).toBe(1);
  });

  it("throws for an `undefined` this with an OBJECT argument", async () => {
    expect(
      await runStandalone(
        `
        var t = 0;
        try { Object.prototype.isPrototypeOf.call(undefined, {}); }
        catch (e) { t = (e instanceof TypeError) ? 1 : 2; }
      `,
        "t",
      ),
    ).toBe(1);
  });

  it("does NOT throw for a nullish `this` with a PRIMITIVE argument — step 1 answers false first", async () => {
    // The row that passes today and must keep passing: a receiver-only gate
    // would throw here, which is a WRONG answer, not a missing one.
    expect(
      await runStandalone(
        `
        var t = 0;
        try { t = Object.prototype.isPrototypeOf.call(null, 1) === false ? 1 : 3; }
        catch (e) { t = 2; }
      `,
        "t",
      ),
    ).toBe(1);
  });
});

describe("#4623 measured residual — a FUNCTION-valued .prototype has no chain edge", () => {
  // `S13.2.2_A1_T1/_T2` need a second fact this issue does NOT provide: an
  // instance's [[Prototype]] must BE the object `F.prototype` reads, and a
  // FUNCTION in that slot cannot be held by the `(ref null $Object)` `$proto`
  // field (the #4480 S2 fnctor-representation residual). Measured on both
  // lanes: `Object.getPrototypeOf(m) === P` is false, so a CORRECT chain walk
  // still answers false. Pinned failing so the day the representation lands,
  // this test says so.
  //
  // (#4637 A1) **It landed, on STANDALONE.** `src/codegen/proto-function-value.ts`
  // canonicalizes a callable to its own-property bag `$Object` at the
  // proto-position choke points, with a reverse map so `getPrototypeOf` still
  // answers the function. The standalone pin below is now an ordinary `it`, and
  // `S13.2.2_A1_T1` / `_T2` pass. The JS-host pin stays `it.fails`: that arm is
  // gated on `ctx.standalone || ctx.wasi`, because in host mode the
  // `env::__extern_*` / `__boundary_object_*` imports own the prototype chain,
  // so the same canonicalization would have to be stated a second time inside
  // the host runtime. Deliberately not done here — one representation, one lane,
  // one measurement.
  const SHAPE = `
    function P() {}
    function F() {}
    F.prototype = P;
    var m = new F();
  `;

  it("standalone: P.isPrototypeOf(new F()) is true when F.prototype = P", async () => {
    expect(await runStandalone(SHAPE, "P.isPrototypeOf(m) === true ? 1 : 0")).toBe(1);
  });

  it.fails("JS host: P.isPrototypeOf(new F()) is true when F.prototype = P", async () => {
    expect(await runHost(SHAPE, "P.isPrototypeOf(m) === true ? 1 : 0")).toBe(1);
  });

  it("the OBJECT-valued twin already links on standalone (why the residual is about functions)", async () => {
    expect(
      await runStandalone(
        `
        function B() {}
        B.prototype = { y: 2 };
        var b = new B();
      `,
        "Object.getPrototypeOf(b) === B.prototype ? 1 : 0",
      ),
    ).toBe(1);
  });
});
