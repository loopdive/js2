/**
 * #6651 cluster A, slice A3 — the standalone `%GeneratorFunction%` intrinsic.
 *
 * Before A3, `Object.getPrototypeOf(function* () {})` (a generator EXPRESSION)
 * fell to the generic callable arm and answered `%Function.prototype%`; only a
 * generator DECLARATION's name reached the `%GeneratorFunction.prototype%`
 * singleton, and that singleton owned a single, writable, enumerable
 * `prototype`. `.constructor` read `undefined`, `@@toStringTag` was absent and
 * `%GeneratorPrototype%.constructor` did not exist.
 *
 * Verified against the base commit: the first three cases are RED there
 * (answers 2, a trap, and 30 — base's `.constructor` was `%Function%`, whose
 * `length` 1 made `built-ins/GeneratorFunction/length.js` pass for the wrong
 * reason). The object-literal METHOD case is a GUARD, green on base only
 * because both sides answered `%Function.prototype%`; the first cut of A3
 * turned it red (test262 `object/method-definition/generator-prototype.js`).
 * The two CONTROL cases pin that the predicate does not claim a value it
 * cannot prove is a generator function (the replaced-method control answers 1
 * on base, by the same both-sides-wrong coincidence).
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";

type Compiled = { success: boolean; binary: Uint8Array; errors?: unknown };

async function run(src: string): Promise<unknown> {
  const r = (await compile(src, { fileName: "t.ts", target: "standalone" })) as unknown as Compiled;
  expect(r.success, `compile failed: ${JSON.stringify(r.errors).slice(0, 300)}`).toBe(true);
  // Instantiating with NO import object is itself the host-free assertion.
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => unknown }).test();
}

describe("#6651 A3 · %GeneratorFunction% / %GeneratorFunction.prototype% (§27.3)", () => {
  it("getPrototypeOf(generator EXPRESSION) is the one %GeneratorFunction.prototype%", async () => {
    const src = `function* g() {}
function f() {}
export function test(): number {
  const a: any = Object.getPrototypeOf(function* () {});
  const b: any = Object.getPrototypeOf(g);
  const fp: any = Object.getPrototypeOf(f);
  let r = 0;
  if (a === b) r |= 1;
  if (a !== fp) r |= 2;
  if (Object.getPrototypeOf(a) === fp) r |= 4;
  return r;
}`;
    expect(await run(src)).toBe(7);
  });

  it("%GeneratorFunction.prototype% own properties and attributes", async () => {
    const src = `export function test(): number {
  const G: any = Object.getPrototypeOf(function* () {});
  let r = 0;
  if (G[Symbol.toStringTag] === "GeneratorFunction") r |= 1;
  const p: any = Object.getOwnPropertyDescriptor(G, "prototype");
  if (p && p.writable === false && p.enumerable === false && p.configurable === true) r |= 2;
  const c: any = Object.getOwnPropertyDescriptor(G, "constructor");
  if (c && c.writable === false && c.enumerable === false && c.configurable === true) r |= 4;
  if (G.prototype === Object.getPrototypeOf(function* () {}.prototype)) r |= 8;
  if (G.prototype.constructor === G) r |= 16;
  if (Object.isExtensible(G)) r |= 32;
  return r;
}`;
    expect(await run(src)).toBe(63);
  });

  it("%GeneratorFunction% own properties", async () => {
    const src = `export function test(): number {
  const GF: any = Object.getPrototypeOf(function* () {}).constructor;
  let r = 0;
  if (GF.name === "GeneratorFunction") r |= 1;
  if (GF.length === 1) r |= 2;
  const p: any = Object.getOwnPropertyDescriptor(GF, "prototype");
  if (p && p.writable === false && p.enumerable === false && p.configurable === false) r |= 4;
  if (GF.prototype === Object.getPrototypeOf(function* () {})) r |= 8;
  if (typeof GF === "function") r |= 16;
  return r;
}`;
    expect(await run(src)).toBe(31);
  });

  it("an unchanged object-literal generator METHOD reports the same prototype", async () => {
    const src = `var obj = { *method() {} };
export function test(): number {
  return Object.getPrototypeOf(obj.method) === Object.getPrototypeOf(function* () {}) ? 1 : 0;
}`;
    expect(await run(src)).toBe(1);
  });

  it("CONTROL: a method replaced after the literal is not claimed as a generator", async () => {
    const src = `var obj: any = { *method() {} };
obj.method = function () {};
export function test(): number {
  return Object.getPrototypeOf(obj.method) === Object.getPrototypeOf(function* () {}) ? 1 : 0;
}`;
    expect(await run(src)).toBe(0);
  });

  it("CONTROL: an ordinary function declaration still reports %Function.prototype%", async () => {
    const src = `function f() {}
function* g() {}
export function test(): number {
  return Object.getPrototypeOf(f) === Object.getPrototypeOf(Object.getPrototypeOf(g)) ? 1 : 0;
}`;
    expect(await run(src)).toBe(1);
  });
});

async function runJs(src: string): Promise<unknown> {
  const r = (await compile(src, {
    fileName: "t.js",
    target: "standalone",
    allowJs: true,
    skipSemanticDiagnostics: true,
  } as never)) as unknown as Compiled;
  expect(r.success, `compile failed: ${JSON.stringify(r.errors).slice(0, 300)}`).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => unknown }).test();
}

describe("#6651 A3 · generator METHODS with a folded non-identifier name", () => {
  // Before A3 the candidate gate refused every string / numeric / computed
  // method name, so these fell to the eager host buffer and leaked `env::__gen_*`
  // (the no-import instantiate fails). Both emit sites already key the method
  // by the folded name, which is what the gate now checks.
  it("class `*['a']()` and object `*[1]()` are lazy native generators", async () => {
    const src = `class C { *['a']() { yield 1; yield 2; } }
var o = { *[1]() { yield 3; } };
export function test() {
  var it = new C().a();
  var r = it.next().value * 100 + it.next().value * 10;
  r += o[1]().next().value;
  if (typeof C.prototype.a === "function") r += 1000;
  return r;
}`;
    expect(await runJs(src)).toBe(1123);
  });

  it("an anonymous `export default function* () {}` compiles natively", async () => {
    // Before A3 the unnamed declaration failed the candidate gate and hit the
    // #680 refusal (compile error) — test262
    // `module-code/eval-export-dflt-gen-anon-semi.js`.
    const src = `var count = 0;
export default function* () { yield 1; }
if (true) { count += 1; }
export function test() { return count; }`;
    expect(await runJs(src)).toBe(1);
  });
});

describe("#6651 A3 · an object-literal generator method on the OPEN-object lane", () => {
  // `var obj = {}` first fixes the binding's type, so the second literal lowers
  // to an open `$Object` and its methods through `emitObjectLiteralMethodFn` →
  // `compileArrowAsClosure`, whose generator tests all read
  // `ts.isFunctionExpression`. The method compiled as a PLAIN closure: the body
  // ran on the call and `.next` read off `undefined` (C4's two rows).
  it("is lazy and delivers its yields and return value", async () => {
    // Top-level shape, as in the test262 rows. (`this` inside the method is
    // covered by the runner probe recorded in the #6651 A3 entry; under this
    // harness's default compile options a `this === obj` read answers false
    // for `method: function* () {}` too, so it is not this lane's to pin.)
    const src = `var obj = {};
var log = [];
var obj = {
  *method(a, b = 5) {
    log.push(1);
    yield a + b;
    return 9;
  }
};
var it = obj.method(1);
var R = log.length * 1000;
R += it.next().value * 10;
var last = it.next();
R += last.done === true && last.value === 9 ? 100 : 0;
R += log.length * 10000;
export function test() {
  return R;
}`;
    expect(await runJs(src)).toBe(10160);
  });
});
