/**
 * #6651 slice V9 (adopts #6836) — two valid ES2015 `for` heads the TypeScript
 * parser rejects or misparses, fixed by the insertion-only pre-parse leaf
 * `src/compiler/for-head-parser-compat.ts`:
 *
 * L  sloppy `let` as an IdentifierReference heading an ordinary `for`
 *    (`statements/for/head-lhs-let.js`): `for (let; ;)`, `for (let = 3; ;)`.
 *    Rewritten to `for (0, let …; ;)` — the target stays a bare identifier.
 * A  an `in` expression as an array-element default in a `for` head
 *    (`statements/for-of/dstr/array-elem-init-in.js`): `[x = 'x' in {}]`.
 *    Rewritten to `[x = ('x' in {})]`.
 *
 * The leaf cases pin the exact admission boundary (strict, class, escaped,
 * Module goal, `let x` / `let [` / for-in / for-of heads, invalid targets stay
 * untouched). The runtime cases run `--target standalone` and assert the
 * observable semantics, including that the bare `let` read really happens.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";
import { normalizeForHeadParserCompat } from "../src/compiler/for-head-parser-compat.ts";

const SCRIPT = { scriptGoal: true };
const rewrite = (src: string, scriptGoal = true) => normalizeForHeadParserCompat(src, { scriptGoal }).source;

describe("#6651 V9 · leaf: sloppy identifier `let` in a for head (L)", () => {
  it.each([
    ["for ( let; ; ) break;", "for ( 0, let; ; ) break;"],
    ["for ( let = 3; ; ) break;", "for ( 0, let = 3; ; ) break;"],
    ["for (let.x = 1;;) break;", "for (0, let.x = 1;;) break;"],
    ["for (let(1);;) break;", "for (0, let(1);;) break;"],
    ["for (let\n= 1;;) break;", "for (0, let\n= 1;;) break;"],
    ["for (/*c*/ let /*d*/ = 3;;) break;", "for (/*c*/ 0, let /*d*/ = 3;;) break;"],
    ["function f(){ for (let = function(){};;) break; }", "function f(){ for (0, let = function(){};;) break; }"],
  ])("rewrites %j", (src, out) => {
    expect(rewrite(src)).toBe(out);
  });

  it.each([
    "for ( [let][0]; ; ) break;",
    "for (let x;;) break;",
    "for (let\nx;;) break;",
    "for (let [a] = [];;) break;",
    "for (let {a} = {};;) break;",
    "for (let in {}) ;",
    "for (let of []) ;",
    "for (\\u006cet;;) break;",
    "'use strict'; for (let;;) break;",
    "function f(){ 'use strict'; for (let;;) break; }",
    "class C { m(){ for (let;;) break; } }",
  ])("leaves %j untouched", (src) => {
    expect(rewrite(src)).toBe(src);
  });

  it("never rewrites outside an explicit Script goal", () => {
    expect(rewrite("for (let;;) break;", false)).toBe("for (let;;) break;");
  });

  it("maps positions after the insertion back to the original column", () => {
    const src = "for ( let = 3; ; ) foo;";
    const r = normalizeForHeadParserCompat(src, SCRIPT);
    const fooOut = r.source.indexOf("foo");
    expect(r.positionMap.toInputOffset(fooOut)).toBe(src.indexOf("foo"));
  });
});

describe("#6651 V9 · leaf: `in` inside an array-element default in a for head (A)", () => {
  it.each([
    ["for ([ x = 'x' in {} ] of [[]]) {}", "for ([ x = ('x' in {}) ] of [[]]) {}"],
    ["for ([ x = 'x' in {} ];;) {}", "for ([ x = ('x' in {}) ];;) {}"],
    ["for ([ x = 'x' in {} ] in {}) {}", "for ([ x = ('x' in {}) ] in {}) {}"],
    ["for ([ x = 'x' in {}, y = 'y' in {} ] of [[]]) {}", "for ([ x = ('x' in {}), y = ('y' in {}) ] of [[]]) {}"],
    ["for ([[ x = 'x' in {} ]] of [[[]]]) {}", "for ([[ x = ('x' in {}) ]] of [[[]]]) {}"],
  ])("rewrites %j", (src, out) => {
    expect(rewrite(src)).toBe(out);
    expect(rewrite(src, false)).toBe(out); // grammar fix, not goal-dependent
  });

  it.each([
    "for ([ f() = 'x' in {} ] of [[]]) {}", // invalid target keeps its parse error
    "for ([ ...x = 'x' in {} ] of [[]]) {}",
    "for (x = 'x' in {};;) {}", // head-level NoIn stays an error
    "for ([ x = ('x' in {}) ] of [[]]) {}",
    "for ([ x = /in/ ] of [[]]) {}",
    "var a = ['b' in {}];",
  ])("leaves %j untouched", (src) => {
    expect(rewrite(src)).toBe(src);
  });
});

type Compiled = { success: boolean; binary: Uint8Array; errors?: unknown };

async function run(src: string): Promise<unknown> {
  const r = (await compile(src, {
    fileName: "t.js",
    allowJs: true,
    target: "standalone",
    skipSemanticDiagnostics: true,
    inferModuleStrictArguments: false,
  })) as unknown as Compiled;
  expect(r.success, `compile failed: ${JSON.stringify(r.errors).slice(0, 300)}`).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => unknown }).test();
}

describe("#6651 V9 · runtime (standalone)", () => {
  it("`for (let; ;)` reads and `for (let = 3; ;)` assigns the var named let", async () => {
    const src = `var let;
export function test() {
  var r = 0;
  let = 1;
  for ( let; ; ) break;
  if (let === 1) r += 1;
  let = 2;
  for ( let = 3; ; ) break;
  if (let === 3) r += 10;
  let = 4;
  for ( [let][0]; ; ) break;
  if (let === 4) r += 100;
  return r;
}`;
    expect(await run(src)).toBe(111);
  });

  it("the bare `let` read really happens: an unresolvable `let` throws ReferenceError", async () => {
    const src = `export function test() {
  try { for (let; ;) break; return 0; } catch (e) { return e instanceof ReferenceError ? 1 : 2; }
}`;
    expect(await run(src)).toBe(1);
  });

  it("an assignment head keeps NamedEvaluation for the bare `let` target", async () => {
    const src = `var let;
export function test() {
  for (let = function () {}; ; ) break;
  return let.name === "let" ? 1 : 0;
}`;
    expect(await run(src)).toBe(1);
  });

  it("an array-element default with `in` runs only for undefined", async () => {
    const src = `var x;
export function test() {
  var counter = 0, r = 0;
  for ([ x = 'x' in {} ] of [[]]) { if (x === false) r += 1; counter += 1; }
  for ([ x = 'x' in {} ] of [[5]]) { if (x === 5) r += 10; counter += 1; }
  return r + counter * 100;
}`;
    expect(await run(src)).toBe(211);
  });
});
