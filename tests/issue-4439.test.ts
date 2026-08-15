// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4439 — reflective `String.prototype.match` / `search` in `--target
 * standalone`, plus the dynamic-pattern refusal's move from CONSTRUCTION to
 * first USE.
 *
 * Three defects, three groups below:
 *
 *  1. **A borrowed `match`/`search` runs natively.** `o.search = String.
 *     prototype.search; o.search(v)` reaches the `native-proto.ts` closure
 *     factory, whose String glue had no arm for these two members — so the
 *     call threw `String.prototype.search is not yet implemented in --target
 *     standalone`. The argument is dispatched at RUNTIME: `ref.test
 *     $NativeRegExp` for a real RegExp, `__regex_compile_dynamic_simple` on
 *     `ToString(arg)` otherwise.
 *  2. **No host import leaks.** `runStandalone` asserts the module imports
 *     NOTHING. That is the regression guard for the second defect, which was
 *     not in the String lane at all: the `any`-receiver extern-class
 *     first-match loop bound `o.match(v)` to `env::Cache_match` (the DOM
 *     `Cache` interface declares `match`), unsatisfiable host-free.
 *  3. **An out-of-subset dynamic pattern constructs.** `new RegExp(objWith-
 *     ToString("[0-9]"), "gim")` is a valid pattern this runtime grammar
 *     cannot compile; §22.2.3.1 does not fail for it, so construction must
 *     succeed and expose the flags/source. The refusal fires — still a
 *     catchable TypeError, never a Wasm trap — only when the value is used.
 *
 * Two harness constraints, both learned by getting them wrong first:
 *
 *  - **Compile as JAVASCRIPT** (`allowJs` + a `.js` fileName), which is what
 *    test262 does. The borrowed-method shapes are lowered differently in the
 *    TypeScript lane — `o.search(v)` on a `const o: any` never reaches the
 *    reflective closure there — so a TS-worded version of these cases would
 *    assert nothing about this code.
 *  - **Compare, don't coerce.** A reflective closure returns a BOXED number
 *    externref; `(v as number)` in arithmetic reads NaN. `v === 2` is the
 *    idiom every sibling reflective-closure suite uses (see
 *    `issue-2875-slice3-search.test.ts`).
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string, fn = "f"): Promise<unknown> {
  const r = await compile(src, {
    target: "standalone",
    allowJs: true,
    fileName: "issue-4439.js",
    skipSemanticDiagnostics: true,
  });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const mod = await WebAssembly.compile(r.binary as BufferSource);
  // The whole point of the standalone lane — and the `Cache_match` guard.
  expect(WebAssembly.Module.imports(mod)).toEqual([]);
  const { exports } = await WebAssembly.instantiate(mod, {});
  return (exports as Record<string, () => unknown>)[fn]!();
}

/** `new Object(true)` → the boxed-primitive receiver the sputnik battery uses. */
const BORROWED = `var o = new Object(true);
  o.search = String.prototype.search;
  o.match = String.prototype.match;`;

describe("#4439 — borrowed String.prototype.search", () => {
  it.each([
    // Lane A — the argument already carries the native RegExp brand.
    ["RegExp argument", `o.search(/ue/) === 2`],
    // Lane B — ToString(arg) → the runtime pattern compiler.
    ["boolean argument", `o.search(true) === 0`],
    ["string argument", `o.search("ue") === 2`],
    ["no match", `o.search("zz") === -1`],
    // RegExpCreate(undefined) is the EMPTY pattern, so this is 0, not -1.
    ["absent argument", `o.search() === 0`],
  ])("%s", async (_label, test) => {
    expect(await runStandalone(`export function f() { ${BORROWED} return (${test}) ? 1 : 0; }`)).toBe(1);
  });

  it("throws a catchable TypeError on a null receiver", async () => {
    const src = `export function f() {
      try { String.prototype.search.call(null, "a"); return 0; }
      catch (e) { return (e instanceof TypeError) ? 1 : 2; }
    }`;
    expect(await runStandalone(src)).toBe(1);
  });
});

describe("#4439 — borrowed String.prototype.match", () => {
  it.each([
    ["exec-shaped element 0", `m !== null && m[0] === "true"`],
    ["spec `index` own property", `m !== null && m.index === 0`],
    ["null on a miss", `o.match("zz") === null`],
  ])("%s", async (_label, test) => {
    const src = `export function f() { ${BORROWED} var m = o.match(true); return (${test}) ? 1 : 0; }`;
    expect(await runStandalone(src)).toBe(1);
  });

  it("takes the all-matches walk for a GLOBAL RegExp, resolved at runtime", async () => {
    // The reflective body has no regex EXPRESSION, so `g` is read off the
    // struct's flags field at RUNTIME. Emitting only the exec arm would answer
    // 1 here instead of 3 — a silent wrong answer, which is why the runtime
    // branch exists.
    const src = `export function f() {
      var n = new Object(1011);
      n.match = String.prototype.match;
      var g = n.match(/1/g);
      return (g !== null && g.length === 3) ? 1 : 0;
    }`;
    expect(await runStandalone(src)).toBe(1);
  });

  it("keeps the exec shape for a NON-global RegExp on the same receiver", async () => {
    const src = `export function f() {
      var n = new Object(1011);
      n.match = String.prototype.match;
      var e = n.match(/1/);
      return (e !== null && e.length === 1 && e.index === 0) ? 1 : 0;
    }`;
    expect(await runStandalone(src)).toBe(1);
  });
});

describe("#4439 — an out-of-subset dynamic pattern constructs, then refuses on use", () => {
  // A DYNAMIC pattern is required: `new RegExp("[0-9]", "g")` with both
  // operands static is compiled by the STATIC path, which supports classes.
  const DYNAMIC = `new RegExp({ toString: function () { return "[0-9]"; } }, (function () { return "gim"; })())`;

  it.each([
    ["global flag", `re.global === true`],
    ["ignoreCase flag", `re.ignoreCase === true`],
    ["multiline flag", `re.multiline === true`],
    ["lastIndex", `re.lastIndex === 0`],
    ["source is defined", `typeof re.source !== "undefined"`],
  ])("exposes the %s of a pattern the runtime grammar cannot compile", async (_label, test) => {
    expect(await runStandalone(`export function f() { var re = ${DYNAMIC}; return (${test}) ? 1 : 0; }`)).toBe(1);
  });

  it("raises a CATCHABLE TypeError on first use, never a trap", async () => {
    const src = `export function f() {
      var re = ${DYNAMIC};
      try { re.test("a1b"); return 0; }
      catch (e) { return (e instanceof TypeError) ? 1 : 2; }
    }`;
    expect(await runStandalone(src)).toBe(1);
  });

  it("still throws SyntaxError at construction for genuinely invalid syntax", async () => {
    // The lone-`[` shape keeps the spec error FAMILY — only the
    // valid-but-uncompilable patterns were deferred.
    const src = `export function f() {
      try { var bad = new RegExp((function () { return "["; })(), ""); return bad ? 0 : 0; }
      catch (e) { return (e instanceof SyntaxError) ? 1 : 2; }
    }`;
    expect(await runStandalone(src)).toBe(1);
  });
});
