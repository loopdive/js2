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

  describe("same-frame declarations — the gate must DECLINE (regressions from the first cut)", () => {
    // Both of these PASSED before #4456, REGRESSED when the gate shipped without
    // a cross-frame requirement, and are the reason the predicate now compares
    // enclosing function scopes. They are the exact test262 shapes, reduced.
    it("Annex-B-inapplicable inner block declaration must not steal the var binding", async () => {
      // annexB/language/function-code/block-decl-nested-blocks-with-fun-decl.js.
      // `g`'s var-scoped `f` is the OUTER block's declaration; the inner block's
      // is deliberately NOT Annex-B applicable. Shadowing gave `f() === 2`.
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

    it("repeated same-named declarations in ONE frame keep a resolvable call target", async () => {
      // annexB/language/eval-code/direct/var-env-lower-lex-catch-non-strict.js
      // reduced: several same-named declarations hoisted into the SAME frame.
      // Each shadow freed the name with nothing to restore it, and a later call
      // resolved to an index that had been scoped away — a hard compile error,
      // `absoluteFuncIndex: unresolved call target (funcIdx=undefined)`.
      expect(
        await runStandalone(`
          export function test(): number {
            try { throw null; } catch (err) {
              { function err2() { return 1; } }
              { function err2() { return 2; } }
              { function err2() { return 3; } }
              return err2();
            }
          }
        `),
      ).toBe(3);
    });
  });

  describe("residuals — known-failing shapes, pinned so a fix is noticed", () => {
    it.fails("a nested declaration shadowing a same-named CONSTANT-FOLDABLE top-level one", async () => {
      // Owner: the IR front-end's direct-call binding resolution
      // (`src/ir/from-ast.ts`, `cx.scope.get(calleeName)` + the AST-site call
      // plan), which is bare-name keyed and picks the top-level unit. The
      // scope fix DOES emit B's own function — disassembly shows it — but the
      // IR plan calls the top-level one and `passes/inline-small.ts` then
      // inlines its constant body. Narrow: with a non-constant top-level
      // `inner` the same source lowers to a correct `return_call`.
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
