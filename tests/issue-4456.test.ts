// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4456) Same-named nested function declarations in DIFFERENT scopes must be
// DIFFERENT functions. R8 of #4437, split out as a correctness bug.
//
// ## What these tests are shaped against
//
// The base defect was that `ctx.funcMap` is a flat, permanent bare-name
// namespace, so the hoist gate read "already compiled" for the second
// declaration and never compiled it: exactly one `(func $inner …)` reached the
// module. Two observable consequences, and the tests below deliberately assert
// the SECOND one everywhere:
//
//   1. `P() === Q()` — closure-value identity. Downstream noise.
//   2. `Q()()` ran `P`'s BODY. The actual damage.
//
// An identity-only assertion is not enough: a fix that only re-keyed the
// closure mint would produce two distinct closure values that both call the
// same body, and would pass an identity check while still running the wrong
// code. So every case pairs distinguishable bodies with a value assertion, and
// identity is asserted separately where it is meaningful.
//
// ## Why the capturing cases carry DIFFERENT bodies
//
// A capturing nested function receives its captures as leading parameters, so
// two same-named declarations whose bodies are `return a` in frames holding
// `a = 1` and `a = 2` produce the right answers from ONE shared physical
// function — the aliasing is invisible. Measured on the base revision: that
// shape "passed" while `return a * 10` / `return a + 10` failed. Any capturing
// case here therefore uses bodies that differ by more than the capture.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { instantiateTest262Module } from "../scripts/test262-import-object.mjs";

async function runStandalone(source: string): Promise<number> {
  const result = await compile(source, {
    allowJs: true,
    fileName: "issue-4456.ts",
    skipSemanticDiagnostics: true,
    target: "standalone",
  });
  expect(result.success, result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  const instance = await instantiateTest262Module(
    result.binary,
    {},
    { target: "standalone", providerLabel: "issue-4456" },
  );
  return (instance.exports as { test(): number }).test();
}

/**
 * Assert that `js` COMPILES. Used for the two regressions that were hard
 * COMPILE ERRORS rather than wrong answers, and that need JS-only syntax
 * (`eval`, async generators) the standalone runner above cannot host.
 */
async function expectCompiles(js: string): Promise<void> {
  const result = await compile(js, {
    allowJs: true,
    fileName: "issue-4456-ce.js",
    skipSemanticDiagnostics: true,
  });
  expect(result.success, result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
}

/**
 * Compile and run `js` on the HOST lane and return `test()`.
 *
 * The standalone runner above cannot host `eval`, and the eval-lane shapes are
 * the ones that force half this predicate, so they need their own runner.
 */
async function runHost(js: string): Promise<number> {
  const result = await compile(js, { allowJs: true, fileName: "issue-4456-host.ts", skipSemanticDiagnostics: true });
  expect(result.success, result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  const { buildImports } = await import("../src/runtime.js");
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
  return (instance.exports as { test(): number }).test();
}

/** Wrap `body` as the whole of an exported `test()`. */
const inTest = (body: string): string => `export function test(): number { ${body} }`;

describe("#4456 — same-named nested function declarations in different scopes", () => {
  it("R8 repro: two nested `inner`s are two functions with two bodies", async () => {
    // Base: 100 (aliased, both bodies ran as `5`). Correct: 123.
    expect(
      await runStandalone(
        inTest(`
          function P() { function inner() { return 5; } return inner; }
          function Q() { function inner() { return 7; } return inner; }
          var p = P(), q = Q();
          return (p() === 5 ? 100 : 0) + (q() === 7 ? 20 : 0) + (p === q ? 0 : 3);
        `),
      ),
    ).toBe(123);
  });

  it("the wrong body ran even with NO closure value in play (direct call)", async () => {
    // The case that proves this was never a closure-mint keying bug: neither
    // declaration escapes its scope, so no closure is minted at all, and the
    // second scope still ran the first's body on the base revision.
    expect(
      await runStandalone(
        inTest(`
          function P() { function inner() { return 5; } return inner(); }
          function Q() { function inner() { return 7; } return inner(); }
          return (P() === 5 ? 10 : 0) + (Q() === 7 ? 2 : 0);
        `),
      ),
    ).toBe(12);
  });

  it("capturing declarations, bodies differing by more than the capture", async () => {
    expect(
      await runStandalone(
        inTest(`
          function P() { var a = 1; function inner() { return a * 10; } return inner; }
          function Q() { var a = 2; function inner() { return a + 10; } return inner; }
          var p = P(), q = Q();
          return (p() === 10 ? 10 : 0) + (q() === 12 ? 2 : 0);
        `),
      ),
    ).toBe(12);
  });

  it("mixed capturing / non-capturing, in both declaration orders", async () => {
    // Order matters to the shadow stack: whichever declaration compiles first
    // owns the bare name, and the second must displace it either way.
    expect(
      await runStandalone(
        inTest(`
          function P() { var a = 5; function inner() { return a; } return inner; }
          function Q() { function inner() { return 7; } return inner; }
          return (P()() === 5 ? 10 : 0) + (Q()() === 7 ? 2 : 0);
        `),
      ),
    ).toBe(12);
    expect(
      await runStandalone(
        inTest(`
          function P() { function inner() { return 5; } return inner; }
          function Q() { var a = 7; function inner() { return a; } return inner; }
          return (P()() === 5 ? 10 : 0) + (Q()() === 7 ? 2 : 0);
        `),
      ),
    ).toBe(12);
  });

  it("an inner declaration SHADOWS an outer same-named one, and the outer survives it", async () => {
    // The half a shadow-without-restore design gets wrong: `Mid` must see its
    // own `inner`, and `Outer`'s call AFTER `Mid` must still see Outer's.
    expect(
      await runStandalone(
        inTest(`
          function Outer() {
            function inner() { return 5; }
            function Mid() { function inner() { return 7; } return inner(); }
            var m = Mid();
            return (inner() === 5 ? 10 : 0) + (m === 7 ? 2 : 0);
          }
          return Outer();
        `),
      ),
    ).toBe(12);
  });

  it("three same-named declarations stay three functions", async () => {
    expect(
      await runStandalone(
        inTest(`
          function P() { function inner() { return 1; } return inner; }
          function Q() { function inner() { return 2; } return inner; }
          function R() { function inner() { return 4; } return inner; }
          var p = P(), q = Q(), r = R();
          var distinct = (p !== q && q !== r && p !== r) ? 100 : 0;
          return distinct + 100 * p() + 10 * q() + r();
        `),
      ),
    ).toBe(224);
  });

  it("same name, different arity", async () => {
    // A shared physical function cannot even have both signatures, so this is
    // the case where aliasing would be most likely to trap rather than lie.
    expect(
      await runStandalone(
        inTest(`
          function P() { function inner(a) { return a * 3; } return inner; }
          function Q() { function inner(a, b) { return a + b + 100; } return inner; }
          var p = P(), q = Q();
          return (p(2) === 6 ? 10 : 0) + (q(1, 1) === 102 ? 2 : 0);
        `),
      ),
    ).toBe(12);
  });

  it("each same-named declaration recurses into ITSELF, not into its twin", async () => {
    expect(
      await runStandalone(
        inTest(`
          function P() { function inner(n) { return n <= 0 ? 0 : n + inner(n - 1); } return inner; }
          function Q() { function inner(n) { return n <= 0 ? 100 : inner(n - 1); } return inner; }
          var p = P(), q = Q();
          return (p(3) === 6 ? 10 : 0) + (q(3) === 100 ? 2 : 0);
        `),
      ),
    ).toBe(12);
  });

  it("nested at different depths, and inside loop bodies", async () => {
    expect(
      await runStandalone(
        inTest(`
          function P() { function m() { function inner() { return 5; } return inner(); } return m(); }
          function Q() { function m2() { function inner() { return 7; } return inner(); } return m2(); }
          return (P() === 5 ? 10 : 0) + (Q() === 7 ? 2 : 0);
        `),
      ),
    ).toBe(12);
    expect(
      await runStandalone(
        inTest(`
          function P() { var r = 0; for (var i = 0; i < 1; i++) { function inner() { return 5; } r = inner(); } return r; }
          function Q() { var r = 0; for (var i = 0; i < 1; i++) { function inner() { return 7; } r = inner(); } return r; }
          return (P() === 5 ? 10 : 0) + (Q() === 7 ? 2 : 0);
        `),
      ),
    ).toBe(12);
  });

  it("owners may be top-level functions, arrows or object-literal methods", async () => {
    expect(
      await runStandalone(`
        function A() { function inner() { return 5; } return inner(); }
        function B() { function inner() { return 7; } return inner(); }
        export function test(): number { return (A() === 5 ? 10 : 0) + (B() === 7 ? 2 : 0); }
      `),
    ).toBe(12);
    expect(
      await runStandalone(
        inTest(`
          var A = () => { function inner() { return 5; } return inner(); };
          var B = () => { function inner() { return 7; } return inner(); };
          return (A() === 5 ? 10 : 0) + (B() === 7 ? 2 : 0);
        `),
      ),
    ).toBe(12);
    expect(
      await runStandalone(
        inTest(`
          var o1 = { m: function () { function inner() { return 5; } return inner; } };
          var o2 = { m: function () { function inner() { return 7; } return inner; } };
          return (o1.m()() === 5 ? 10 : 0) + (o2.m()() === 7 ? 2 : 0);
        `),
      ),
    ).toBe(12);
  });

  describe("controls — shapes that were already correct and must stay correct", () => {
    it("differently-named nested declarations", async () => {
      expect(
        await runStandalone(
          inTest(`
            function P() { function innerA() { return 5; } return innerA(); }
            function Q() { function innerB() { return 7; } return innerB(); }
            return (P() === 5 ? 10 : 0) + (Q() === 7 ? 2 : 0);
          `),
        ),
      ).toBe(12);
    });

    it("same-named declarations with IDENTICAL bodies", async () => {
      // Aliasing is unobservable here; the point is that the extra function the
      // fix now emits does not change the answer.
      expect(
        await runStandalone(
          inTest(`
            function P() { function inner() { return 5; } return inner(); }
            function Q() { function inner() { return 5; } return inner(); }
            return (P() === 5 ? 10 : 0) + (Q() === 5 ? 2 : 0);
          `),
        ),
      ).toBe(12);
    });

    it("same-frame duplicates: two blocks, and if/else (#3419 / Annex B paths)", async () => {
      // These were already right on the base revision — they go through the
      // last-wins and Annex B block paths, not the cross-frame hoist gate, and
      // the gate DECLINES on them (same enclosing function scope). They are
      // here because the first cut of the gate did NOT decline, which is what
      // shipped the two Annex B regressions pinned below.
      expect(
        await runStandalone(
          inTest(`
            function P() {
              var r = 0;
              { function inner() { return 5; } r += (inner() === 5 ? 10 : 0); }
              { function inner() { return 7; } r += (inner() === 7 ? 2 : 0); }
              return r;
            }
            return P();
          `),
        ),
      ).toBe(12);
      expect(
        await runStandalone(
          inTest(`
            function P(f) {
              if (f) { function inner() { return 5; } return inner(); }
              else { function inner() { return 7; } return inner(); }
            }
            return (P(1) === 5 ? 10 : 0) + (P(0) === 7 ? 2 : 0);
          `),
        ),
      ).toBe(12);
    });

    it("same-named function EXPRESSIONS assigned to vars (a different mechanism)", async () => {
      expect(
        await runStandalone(
          inTest(`
            function P() { var inner = function () { return 5; }; return inner(); }
            function Q() { var inner = function () { return 7; }; return inner(); }
            return (P() === 5 ? 10 : 0) + (Q() === 7 ? 2 : 0);
          `),
        ),
      ).toBe(12);
    });

    it("`.name` is still the source name on every same-named declaration", async () => {
      // The #4437 metadata that surfaced this: distinct functions, same `.name`.
      expect(
        await runStandalone(
          inTest(`
            function P() { function inner() { return 5; } return inner; }
            function Q() { function inner() { return 7; } return inner; }
            return (P().name === "inner" ? 10 : 0) + (Q().name === "inner" ? 2 : 0);
          `),
        ),
      ).toBe(12);
    });
  });

  describe("the gate must SHADOW — a top-of-frame decl owns the name at hoist (B.3.3.3)", () => {
    // ## What these are, and what they are NOT
    //
    // The regression that forced this branch of the predicate is the 24-file
    // `annexB/…/eval-{func,global}-{block-decl,if-*,switch-*}-existing-fn-no-init`
    // family: it PASSED on the shipped predicate and went 24× pass→fail (net −22)
    // in the merge queue when the second cut declined for the whole same-frame
    // case. Those 24 files are verified directly against the real runner — 24/24
    // with this predicate, 0/24 with the second cut — and that lane, not this
    // file, is their guard.
    //
    // The cases below are REDUCTIONS of that shape, and they are deliberately
    // NOT described as the family, because measurement says they are not
    // equivalent to it. Values returned (2 = correct, the top-of-frame `"outer
    // declaration"`; 1 = the block-level `"inner declaration"`):
    //
    //   revision                      family      these reductions
    //   pre-#4456 base                PASS        1  (wrong)
    //   #4456 first cut (shipped)     PASS        1  (wrong)
    //   #4456 second cut              FAIL        1  (wrong)
    //   this predicate                PASS        2  (right)
    //
    // So a hand reduction of this shape is HARDER than the family: it was wrong
    // on every previous revision, including the two where the family passed.
    // Several structural knobs were tried and none closed the gap — module-level
    // vs in-function placement, `deferTopLevelInit`, string vs numeric vs
    // non-constant-foldable bodies. The remaining difference is the test262
    // wrapper's harness prelude, which registers a large number of top-level
    // functions before the test body and so changes the hoist environment the
    // predicate sees. Reproducing that faithfully means depending on the
    // test262 checkout and `wrapTest` from a unit test, which this file does
    // not do.
    //
    // They are kept because they are still real, useful pins — each is a shape
    // this predicate FIXES relative to every earlier revision — but read them as
    // "neighbours of the family that this rule also gets right", not as the
    // family's regression guard.
    const corners: ReadonlyArray<readonly [string, string]> = [
      ["direct eval, function scope", `(function() { eval('%%'); }());`],
      ["direct eval, global scope", `eval('%%');`],
      ["indirect eval, global scope", `(0,eval)('%%');`],
    ];
    const carriers: ReadonlyArray<readonly [string, string]> = [
      ["block", `{ function f() { return "inner declaration"; } }`],
      ["switch-case", `switch (1) { case 1: function f() { return "inner declaration"; } }`],
      ["if-no-else", `if (true) { function f() { return "inner declaration"; } }`],
    ];
    const evalArg = (carrier: string) => `init = f;${carrier}function f() { return "outer declaration"; }`;

    for (const [cornerLabel, wrapper] of corners) {
      for (const [carrierLabel, carrier] of carriers) {
        it(`${cornerLabel}, ${carrierLabel} carrier — the pre-existing binding is not modified`, async () => {
          expect(
            await runHost(`var init;
${wrapper.replace("%%", evalArg(carrier))}
export function test(): number { return init() === "outer declaration" ? 2 : 1; }`),
          ).toBe(2);
        });
      }
    }
  });

  describe("the gate must DECLINE — merge-group regressions from the first cut", () => {
    // Each of these PASSED before #4456 and REGRESSED when the gate shipped, and
    // each is pinned against the state that actually reproduced: every `it` here
    // was re-run against `origin/main`'s un-narrowed predicate and observed to
    // fail there. The clauses are independent — measured 2026-08-15, no one of
    // them fixes all of these — so each gets a pin.

    it("[block-vs-block] Annex-B-inapplicable inner block decl must not steal the var binding", async () => {
      // annexB/language/function-code/block-decl-nested-blocks-with-fun-decl.js.
      // `g`'s var-scoped `f` is the OUTER block's declaration; the inner block's
      // is deliberately NOT Annex-B applicable (replacing it with `var f` would
      // be an early error against the outer block's lexical `f`), so it never
      // rebinds `g`'s `f`. Shadowing let it take the name: `f()` gave 2.
      //
      // NOTE this is the NON-applicable variant, not a counterexample to B.3.3's
      // "rebind as each declaration is evaluated" rule — for APPLICABLE sibling
      // blocks last-executed-wins is correct, and that shape is a control above.
      expect(
        await runStandalone(`
          function g(): number {
            { function f() { return 1; } { function f() { return 2; } } }
            return f();
          }
          export function test(): number { return g(); }
        `),
      ).toBe(1);
    });

    it("[both top-of-frame] several eval declarations keep a resolvable call target", async () => {
      // annexB/language/eval-code/direct/var-env-lower-lex-catch-non-strict.js,
      // verbatim. Each synthesized declaration is reified into the SAME catch
      // frame, so the shadows had no body boundary to be restored at and
      // accumulated; a later call then resolved to an index that had been scoped
      // away — `absoluteFuncIndex: unresolved call target (funcIdx=undefined)
      // baked into a compiled function body`.
      //
      // TWO parts of the predicate are load-bearing here, both measured:
      //  - `sameFrame` must merge the four DISTINCT `<eval>.ts` SourceFiles the
      //    four eval calls produce, or they read as cross-frame and the CE comes
      //    straight back (it did, on the first attempt at the third cut);
      //  - the same-frame rule must then decline, which it does because BOTH
      //    sides are top-of-frame — the directional half of the rule.
      // The OWNER clause alone does not fix this one: each incumbent here does
      // carry an owner record.
      await expectCompiles(`
        try { throw null; } catch (err) {
          eval('function err() {}');
          eval('function* err() {}');
          eval('async function err() {}');
          eval('async function* err() {}');
        }
      `);
    });

    it("[owner clause] an eval declaration must not displace a TOP-LEVEL registration", async () => {
      // The second, distinct trigger for the same CE, and the smallest shape
      // that reaches it: a top-level declaration owns the name, and an
      // eval-synthesized async generator of the same name arrives. A top-level
      // declaration has NO `funcMapOwnerDecl` record (#4133's convention), so
      // the first cut read "no record ⇒ different owner ⇒ shadow" and deleted a
      // registration nothing would restore.
      //
      // Measured: the SCOPE clause alone does NOT fix this one — the incumbent's
      // scope cannot even be computed without an owner record — which is why
      // both clauses are load-bearing rather than one being a superset.
      await expectCompiles(`
        function err() { return 1; }
        eval('async function* err() {}');
      `);
    });

    it("same-frame block duplicates still resolve to the last one executed", async () => {
      // A control, not a pin: this shape compiles on the un-narrowed gate too.
      // It is here because it is the Annex-B-APPLICABLE sibling of the first
      // test — B.3.3 rebinds the var-scoped name as each declaration is
      // evaluated, so last-executed-wins is the CORRECT answer and the gate
      // must not "heal" it into per-block functions.
      expect(
        await runStandalone(`
          export function test(): number {
            { function err2() { return 1; } }
            { function err2() { return 2; } }
            { function err2() { return 3; } }
            return err2();
          }
        `),
      ).toBe(3);
    });
  });

  describe("residuals — known-failing shapes, pinned so a fix is noticed", () => {
    it.fails("a nested declaration shadowing a same-named TOP-LEVEL one", async () => {
      // Deliberately not fixed, and the reason CHANGED with the narrowing —
      // the observable result did not, which is why this stayed an `it.fails`
      // through both cuts.
      //
      //   first cut  the gate shadowed the top-level registration, so B's own
      //              function WAS emitted (two `inner`s in the module, counted
      //              from the binary) and the wrong one was merely CALLED: the
      //              IR front-end's bare-name direct-call plan
      //              (`src/ir/from-ast.ts`) picked the top-level unit and
      //              `passes/inline-small.ts` inlined its constant body.
      //   narrowed   the gate DECLINES on an incumbent with no
      //              `funcMapOwnerDecl` record, so B's declaration is not
      //              compiled at all (one `inner` in the module) — exactly the
      //              pre-#4456 lowering.
      //
      // That trade is deliberate: shadowing an owner-less registration is the
      // very thing that produced the `funcIdx=undefined` compile error pinned
      // above, and it bought nothing here — the answer was already wrong.
      // Fixing this shape for real belongs to the IR call-binding resolution,
      // not to this gate.
      expect(
        await runStandalone(`
          function inner() { return 5; }
          function B() { function inner() { return 7; } return inner(); }
          export function test(): number { return (inner() === 5 ? 10 : 0) + (B() === 7 ? 2 : 0); }
        `),
      ).toBe(12);
    });

    it.fails("owners are CLASS methods", async () => {
      // Owner: class method bodies never call `hoistFunctionDeclarations` at
      // all (`src/codegen/class-bodies.ts` hoists only vars and let/const), so
      // the #4456 shadow gate — which lives in the hoist — never runs for
      // them. Independently observable: a forward call to a nested declaration
      // inside a method does not resolve either.
      expect(
        await runStandalone(`
          class C { m() { function inner() { return 5; } return inner(); } n() { function inner() { return 7; } return inner(); } }
          export function test(): number { var c = new C(); return (c.m() === 5 ? 10 : 0) + (c.n() === 7 ? 2 : 0); }
        `),
      ).toBe(12);
    });
  });
});
