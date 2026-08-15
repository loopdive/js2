// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3468 C-core — closure-own-property side table (`--target standalone`).
 *
 * Function objects (closures) are WasmGC structs, not `$Object`s, so
 * `__extern_set`/`__extern_get`/`__extern_method_call` all fell through their
 * "not a `$Object`" arm for a closure receiver — dropping own-property writes,
 * reading them back as undefined, and returning undefined from a method call.
 * That is why the test262 `assert` harness (whose `sameValue`/`throws`/
 * `_isSameValue` are own properties of a `function assert(){}`) never fired
 * under standalone → vacuous passes.
 *
 * C-core gives those three arms a runtime, closure-identity-keyed side table
 * (`src/codegen/closure-props.ts`): each property-carrying closure gets a fresh
 * `$Object` "bag" reached by `ref.eq` on the closure identity, reusing the
 * existing `$Object` prop machinery.
 *
 * ## Two parts (#3468 F1 — the full rollout, per the 2026-07-23 stakeholder ruling)
 * 1. **Runtime substrate** — the closure-own-property side table, reached via
 *    the DYNAMIC member path (`__extern_set`/`__extern_get`/
 *    `__extern_method_call` → the closure arms). The carrier classifier now
 *    covers ALL closure wrapper structs (base-wrapper `ref.test` chain), not
 *    just capturing subtypes — shared noncapturing wrappers (the harness
 *    receiver shape) carry own properties too.
 * 2. **Top-level front-end routing** — a `F.<name> = …` write on a top-level
 *    FUNCTION DECLARATION (the test262 `assert.sameValue = function(){…}`
 *    shape) was DROPPED under standalone: the #2671 keep that retains such
 *    statements in `__module_init` was gated `!ctx.standalone`. So
 *    `assert.sameValue` never stored and `assert.sameValue(1,2)` invoked
 *    `undefined` → every assertion was a VACUOUS PASS. A standalone counterpart
 *    keep (declarations.ts) retains the statement so the ordinary write-arm
 *    records it in the side table. Reads and calls on a function receiver
 *    already routed dynamically. Exclusions: `.name`/`.length`/`.call`/
 *    `.apply`/`.bind`/`.prototype`/`.constructor`, class statics, non-identifier
 *    receivers. gc/host is untouched (byte-identical).
 *
 * The harness assertions FIRING (instead of vacuous-passing) is the designed,
 * stakeholder-ruled floor de-inflation — the exposed failures are measured from
 * the merge-group run and routed to trackers; see the issue file.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<{ ret: unknown; threw: boolean; err?: string }> {
  const r = await compile(src, {
    target: "standalone",
    allowJs: true,
    fileName: "issue-3468.ts",
    skipSemanticDiagnostics: true,
  });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  // Property writes can run either during module initialization or from the
  // exported test function, so keep instantiation and invocation in one catch.
  try {
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    const fn = (instance.exports.test ?? instance.exports.main) as ((...a: unknown[]) => unknown) | undefined;
    return { ret: fn?.(), threw: false };
  } catch (e) {
    return { ret: undefined, threw: true, err: String((e as Error)?.message ?? e) };
  }
}

describe("#3468 C-core — closure own-property side table (dynamic path, verified)", () => {
  it("round-trips an own property written+read on a function value", async () => {
    const { ret } = await runStandalone(`
      export function test(): number {
        let seed = 1;
        const memo = () => seed;
        const g = memo;
        (g as any).cache = 5;
        return (g as any).cache;
      }
    `);
    expect(ret).toBe(5);
  });

  it("invokes a method stored on a function value (distinctive 777 sentinel, not falsy)", async () => {
    const { ret } = await runStandalone(`
      export function test(): number {
        let seed = 1;
        const f = () => seed;
        const g = f;
        (g as any).m = () => 777;
        return (g as any).m();
      }
    `);
    expect(ret).toBe(777);
  });

  it("runs the method body's side effects (a global written inside the method sticks)", async () => {
    const { ret } = await runStandalone(`
      let flag = 0;
      export function test(): number {
        let seed = 1;
        const f = () => seed;
        const g = f;
        (g as any).setter = () => { flag = 9; return 0; };
        (g as any).setter();
        return flag;
      }
    `);
    expect(ret).toBe(9);
  });

  it("keys the side table on closure identity: write via g, read via the same closure", async () => {
    const { ret } = await runStandalone(`
      export function test(): number {
        let seed = 1;
        const fn = () => seed;
        const g = fn;
        (g as any).x = 5;
        return (fn as any).x;
      }
    `);
    expect(ret).toBe(5);
  });

  it("keeps distinct closures' own properties isolated (no cross-talk)", async () => {
    const { ret } = await runStandalone(`
      export function test(): number {
        let aSeed = 1, bSeed = 2;
        const a = () => aSeed;
        const b = () => bSeed;
        const ga = a, gb = b;
        (ga as any).v = 11;
        (gb as any).v = 22;
        return (ga as any).v;
      }
    `);
    expect(ret).toBe(11);
  });

  it("does not let a custom own property shadow the builtin metadata path", async () => {
    // The invariant under test is unchanged: writing a custom own property must
    // NOT disturb `.length` — the #3468 side table does not shadow the metadata
    // arm.
    //
    // (#4436) The EXPECTED VALUE changed from 0 to 2. The 0 was never this
    // test's subject; it was the flat `box_number(0)` the dyn-read closure arm
    // returned for any closure the #2896 builtin-meta helper declined ("arity
    // not statically tracked"). It IS tracked — the `$arity` header slot
    // (#3673) — and the generic user-closure arm now reads it, so a
    // two-parameter arrow correctly answers 2. Pinning 0 here would pin the
    // defect, not the invariant.
    const { ret } = await runStandalone(`
      export function test(): number {
        let seed = 1;
        const fn = (x, y) => seed + x + y;
        const g = fn;
        (g as any).mine = 99;
        return (g as any).length;
      }
    `);
    expect(ret).toBe(2);
  });

  it("includes shared noncapturing wrapper structs in the rollout (#3468 F1)", async () => {
    // Flipped from the #3418 negative control: the F1 widening makes ALL
    // closure wrappers carriers, so a noncapturing arrow round-trips too.
    const { ret } = await runStandalone(`
      export function test() {
        const fn = () => 1;
        const g = fn;
        (g as any).mine = 99;
        return (g as any).mine === 99 ? 1 : 0;
      }
    `);
    expect(ret).toBe(1);
  });
});

describe("#3468 F1 — top-level function-declaration property write (front-end routing)", () => {
  it("stores + reads back a top-level `F.p = v` write on a function declaration", async () => {
    const { ret } = await runStandalone(`
      function memo(){}
      memo.cache = 5;
      export function test(): number { return memo.cache; }
    `);
    expect(ret).toBe(5);
  });

  it("invokes a method assigned at top level on a function declaration", async () => {
    const { ret } = await runStandalone(`
      function assert(){}
      assert.sv = function (a) { return a + 1; };
      export function test(): number { return assert.sv(41); }
    `);
    expect(ret).toBe(42);
  });
});

// The test262 `assert` harness — bare function-DECLARATION member ops at top
// level, the exact shape whose vacuous passes motivated #3468. This is the
// REGRESSION GUARD for the F1 de-inflation: these assertions must FIRE.
describe("#3468 F1 — assert harness fires (vacuous passes correctly fail)", () => {
  const HARNESS = `
    function Test262Error(message) { this.message = message; }
    function assert(mustBeTrue, message) { if (mustBeTrue === true) { return; } throw new Test262Error(message); }
    assert._isSameValue = function (a, b) { if (a === b) { return a !== 0 || 1 / a === 1 / b; } return a !== a && b !== b; };
    assert.sameValue = function (actual, expected, message) { if (assert._isSameValue(actual, expected)) { return; } throw new Test262Error(message); };
  `;

  it("assert.sameValue(1, 2) throws (correcting a vacuous pass)", async () => {
    const { threw } = await runStandalone(HARNESS + `assert.sameValue(1, 2, "m");`);
    expect(threw).toBe(true);
  });

  it("assert.sameValue(2, 2) does not throw (control)", async () => {
    const { threw } = await runStandalone(HARNESS + `assert.sameValue(2, 2);`);
    expect(threw).toBe(false);
  });

  it("assert.throws(TypeError, () => {}) throws when the callback does not", async () => {
    const src =
      HARNESS +
      `assert.throws = function(errType, fn){ try { fn(); } catch(e){ return; } throw new Test262Error("no throw"); };
       assert.throws(TypeError, function(){});`;
    const { threw } = await runStandalone(src);
    expect(threw).toBe(true);
  });
});

describe("#3468 F1 — routing exclusions (no unintended regressions)", () => {
  it("does not affect a class static method call (class is not a function declaration)", async () => {
    const { ret } = await runStandalone(`
      class C { static m(){ return 42; } }
      export function test(): number { return C.m(); }
    `);
    expect(ret).toBe(42);
  });

  it("leaves fn.call / fn.apply working", async () => {
    const { ret } = await runStandalone(`
      function add(a, b){ return a + b; }
      export function test(): number { return add.call(null, 3, 4) + add.apply(null, [10, 20]); }
    `);
    expect(ret).toBe(37);
  });
});
