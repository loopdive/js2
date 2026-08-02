// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3980 — Annex B B.3.3 web-compat function hoisting: the extension is NOT
 * observed when creating the var binding would produce an Early Error.
 *
 * A sloppy-mode `function F` nested in a block / `if` clause / `switch` case
 * normally gets a var-scoped binding in the enclosing function or global scope
 * (B.3.3.1 / B.3.3.2). That is skipped when replacing it with `var F` would be
 * an Early Error — an intervening lexical `F` (a `let`/`const`/`class` in an
 * enclosing block, a lexical `for`/`for-in`/`for-of` head, or a *destructuring*
 * `catch` parameter, B.3.5). Then NO binding for `F` exists: reading `F` must
 * throw ReferenceError and `typeof F` must be `"undefined"`.
 *
 * The compiler used to leak the *lexical* `F` into its flat per-function
 * `localMap`, so a nested closure captured it and the read silently succeeded —
 * which is what all 96
 * `annexB/language/{global,function}-code/*-skip-early-err-*` tests assert
 * against (`assert.throws(ReferenceError, function () { f; })`).
 *
 * Counterpart: when the enclosing scope ALREADY binds the name (a parameter, a
 * `var`, or a scope-top-level `let`), Annex B merely declines to create an
 * ADDITIONAL binding — the existing one stays readable and must NOT throw
 * (`*-skip-param.js`, `*-skip-early-err.js`).
 */
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { compile } from "../src/index.js";
import { collectAnnexBCancelSites } from "../src/codegen/annexb-cancel.js";

/**
 * Compile `body` at global scope surrounded by probes and return a bitmask:
 *   1 = reading `f` from a nested closure BEFORE the body throws ReferenceError
 *   2 = `typeof f` BEFORE the body is "undefined"
 *   4 = reading `f` from a nested closure AFTER the body throws ReferenceError
 *   8 = `typeof f` AFTER the body is "undefined"
 * 15 means "no binding for `f` was ever created", the Annex B skip outcome.
 */
async function unboundMask(body: string): Promise<number> {
  const src = `
var __r: number = 0;
function readF(): number { try { (f as any); return 0; } catch (e) { return 1; } }
__r += readF() * 1;
__r += (typeof f === "undefined" ? 1 : 0) * 2;
${body}
__r += readF() * 4;
__r += (typeof f === "undefined" ? 1 : 0) * 8;
export function test(): number { return __r; }
`;
  const r = await compile(src, { fileName: "test.ts", skipSemanticDiagnostics: true, target: "standalone" });
  expect(r.success, r.errors?.[0]?.message).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary!, {});
  const ex = instance.exports as Record<string, () => number>;
  if (typeof ex.__module_init === "function") ex.__module_init();
  return ex.test();
}

function sitesFor(source: string) {
  const sf = ts.createSourceFile("t.js", source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
  return collectAnnexBCancelSites(sf);
}

describe("#3980 Annex B B.3.3 — extension skipped on Early Error", () => {
  // Declaration position × cancelling lexical binder. Each pair mirrors one of
  // the eight × six generated test262 `*-skip-early-err-*` shapes.
  const shapes: Array<[string, string]> = [
    [
      "block decl / block-level let",
      `{
         let f = 123;
         { function f() {} }
       }`,
    ],
    [
      "block decl / for-in head",
      `for (let f in { a: 0 }) {
         { function f() {} }
       }`,
    ],
    [
      "block decl / for-of head",
      `for (let f of [0]) {
         { function f() {} }
       }`,
    ],
    [
      "if-then decl / for head",
      `for (let f; ; ) {
         if (true) function f() {}
         break;
       }`,
    ],
    [
      "if-else decl / destructuring catch param",
      `try {
         throw {};
       } catch ({ f }) {
         if (true) function _f() {} else function f() {}
       }`,
    ],
    [
      "switch case decl / case-clause let",
      `switch (0) {
         default:
           let f;
           switch (1) {
             case 1:
               function f() {}
           }
       }`,
    ],
    [
      "switch default decl / for-of head",
      `for (let f of [0]) {
         switch (1) {
           default:
             function f() {}
         }
       }`,
    ],
  ];

  for (const [name, body] of shapes) {
    it(`creates no binding: ${name}`, async () => {
      expect(await unboundMask(body)).toBe(15);
    });
  }

  it("a nested-closure read is cancelled too, not just a read in the declaring scope", async () => {
    // Bit 1/4 are exactly the nested-closure reads; asserting the full mask
    // above already covers it, but pin the specific shape that regressed.
    expect(
      await unboundMask(`{
         let f = 123;
         { function f() {} }
       }`),
    ).toBe(15);
  });
});

describe("#3980 Annex B B.3.3 — the extension is NOT cancelled when the scope already binds the name", () => {
  it("a same-named parameter keeps its value (*-skip-param)", () => {
    // `function (f) { { function f() {} } }` — B.3.3 skips creating a NEW
    // binding; the parameter is untouched and must stay readable.
    expect(sitesFor(`(function (f) { init = f; { function f() {} } after = f; }(123));`)).toEqual([]);
  });

  it("a scope-top-level `let` keeps its value (*-skip-early-err)", () => {
    expect(sitesFor(`(function () { let f = 123; { function f() {} } }());`)).toEqual([]);
  });

  it("a scope-level `var` keeps its value", () => {
    expect(sitesFor(`(function () { var f = 123; { let f2; { function f() {} } } }());`)).toEqual([]);
  });

  it("a SIMPLE catch parameter does not cancel (B.3.5 permits `var f` there)", () => {
    expect(sitesFor(`try { throw 0; } catch (f) { { function f() {} } }`)).toEqual([]);
  });

  it("a destructuring catch parameter DOES cancel (B.3.5 Early Error)", () => {
    expect(sitesFor(`try { throw {}; } catch ({ f }) { { function f() {} } }`)).toHaveLength(1);
  });

  it("an eligible sibling declaration in the same scope still creates the binding", () => {
    // staging/sm/lexical-environment/block-scoped-functions-annex-b-notapplicable.js:
    // the first block's `function x` IS eligible, so the two cancelled siblings
    // must not make `x` unbound.
    expect(
      sitesFor(`function f() {
        var outerX;
        { function x() { return 1; } outerX = x; }
        { { function x() { return 2; } } let x; }
        { let x; { function x() { return 3; } } }
      }`),
    ).toEqual([]);
  });

  it("a plain function-body-level declaration is never an Annex B site", () => {
    expect(sitesFor(`function outer() { let f2; function f() {} }`)).toEqual([]);
  });

  it("ordinary code produces no sites at all (the guard is inert)", () => {
    expect(
      sitesFor(`function outer() {
        let a = 1;
        if (a) { function helper() { return a; } return helper(); }
        for (const b of [1, 2]) { { function g() { return b; } g(); } }
      }`),
    ).toEqual([]);
  });
});

/**
 * (#4091) `collectAnnexBCancelSites` is reached from `compileIdentifierCore` as
 * `collectAnnexBCancelSites(id.getSourceFile())`, and `getSourceFile()` returns
 * **undefined** for a *synthesized* identifier — one the compiler manufactured
 * mid-lowering, with no `parent` chain to walk up. Those exist: script-goal
 * top-level `this` is lowered by re-entering `compileIdentifier` with a fresh
 * `ts.factory.createIdentifier("globalThis")` (#3365, `expressions.ts`).
 *
 * Memoizing on that undefined key threw `TypeError: Invalid value used as weak
 * map key`, which `compileExpressionBody`'s speculative catch converted into
 * `Internal error compiling expression` — a **whole-file compile_error** for
 * code with no Annex B content whatsoever. Measured on the #4027 merge_group
 * run: 666 additional test262 files hit it, 152 of them flipping `pass →
 * compile_error` in the host lane and 143 in the standalone lane (100% of that
 * run's non-timeout regressions in BOTH lanes).
 *
 * These two tests are the detector for that. The end-to-end one is the load-
 * bearing half: it fails if the `if (!sf)` guard is removed, which the unit
 * test alone would not.
 */
describe("#4091 — a synthesized identifier has no SourceFile", () => {
  it("collectAnnexBCancelSites(undefined) answers 'no sites' instead of throwing", () => {
    expect(collectAnnexBCancelSites(undefined)).toEqual([]);
  });

  it("script-goal top-level `this` (lowered to a synthesized `globalThis`) still compiles", async () => {
    // Script goal, NOT module: no import/export, so `ctx.sourceIsModule` is
    // false and `this` takes the `createIdentifier("globalThis")` path. Without
    // the guard this reports `Invalid value used as weak map key` and fails.
    const r = await compile(`var g: any = this;\nconsole.log(typeof g);\n`, {
      fileName: "test.ts",
      skipSemanticDiagnostics: true,
    });
    const messages = (r.errors ?? []).map((e) => e.message).join(" | ");
    expect(messages).not.toContain("weak map key");
    expect(r.success, messages).toBe(true);
  });
});
