/**
 * #3673 — `Function.prototype.call`/`apply` on a WasmGC closure (standalone).
 *
 * A closure is not a `$Object`, so `__extern_method_call` routed a method call
 * on a function value to the closure own-property side table (#3468). That
 * table has no `call`/`apply` entry, so a DYNAMICALLY dispatched `fn.call(...)`
 * — one where `fn` is a parameter or field, so the static `.call` rewrites in
 * `calls.ts` cannot fire — resolved to nothing and the whole call expression
 * evaluated to `undefined` instead of invoking the function.
 *
 * Found in compiled acorn: `parseMaybeAssign` does
 * `left = afterLeftParse.call(this, left, startPos, startLoc)` with
 * `afterLeftParse` a parameter, so `left` became `undefined` and every
 * parenthesized/destructuring assignment (`({a: b} = c)`, `(a) = 1`) died on
 * the next line.
 *
 * These pins cover the receiver-and-argument threading that was wrong, both
 * arities, and the own-property precedence the fix must not break.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";

async function runStandalone(source: string): Promise<unknown> {
  const r = await compile(source, { fileName: "t.ts", skipSemanticDiagnostics: true, target: "standalone" });
  expect(r.binary?.length ?? 0).toBeGreaterThan(0);
  const module = await WebAssembly.compile(r.binary as BufferSource);
  expect(WebAssembly.Module.imports(module).length).toBe(0);
  const { exports } = await WebAssembly.instantiate(module, {});
  return (exports as { test?: () => unknown }).test?.();
}

describe("#3673 — Function.prototype.call/apply on a closure (standalone)", () => {
  it("threads thisArg into `this` and the remaining args into the params", async () => {
    // Encodes both halves in one number: this.tag * 100 + item.s.
    const got = await runStandalone(`var P = function P(tag) { this.tag = tag; };
P.prototype.probe = function (item) {
  var t = (this && this.tag !== undefined) ? this.tag : -1;
  var v = (item && item.s !== undefined) ? item.s : -1;
  return t * 100 + v;
};
var p = new P(3);
var f = p.probe;
export function test(): number { return f.call(p, { s: 7 }); }`);
    expect(got).toBe(307);
  });

  it("the acorn shape: a method value passed as a parameter, invoked via .call", async () => {
    const got = await runStandalone(`var P = function P() {};
P.prototype.parseParenItem = function (item) { return item };
P.prototype.run = function (afterLeftParse) {
  var left = { start: 42 };
  if (afterLeftParse) { left = afterLeftParse.call(this, left, 10, 20); }
  return left
};
var p = new P();
export function test(): number {
  var r = p.run(p.parseParenItem);
  return (r === null || r === undefined) ? -1 : r.start;
}`);
    expect(got).toBe(42);
  });

  it("ignores excess args and pads missing ones", async () => {
    const got = await runStandalone(`var P = function P() {};
P.prototype.one = function (a) { return a === undefined ? -1 : a };
P.prototype.three = function (a, b, c) { return (c === undefined ? 0 : c) * 100 + a };
var p = new P();
var one = p.one, three = p.three;
export function test(): number {
  // 1 declared param, 3 passed -> extras dropped, returns 5
  if (one.call(p, 5, 99, 98) !== 5) return -1;
  // 3 declared params, 1 passed -> b/c undefined, returns 0*100+7
  if (three.call(p, 7) !== 7) return -2;
  // 3 declared, 3 passed
  if (three.call(p, 7, 0, 2) !== 207) return -3;
  return 1;
}`);
    expect(got).toBe(1);
  });

  it("apply forwards the array elements as positional args", async () => {
    const got = await runStandalone(`var P = function P(tag) { this.tag = tag; };
P.prototype.sum = function (a, b) { return this.tag + a + b };
var p = new P(1000);
var f = p.sum;
export function test(): number { return f.apply(p, [20, 3]); }`);
    expect(got).toBe(1023);
  });

  it("apply with no args array degrades to a zero-arg call", async () => {
    const got = await runStandalone(`var P = function P(tag) { this.tag = tag; };
P.prototype.get = function () { return this.tag };
var p = new P(9);
var f = p.get;
export function test(): number { return f.apply(p); }`);
    expect(got).toBe(9);
  });

  it("an own-property method on a closure still dispatches (#3468 not regressed)", async () => {
    // Route 1 of the helper: the closure own-property side table must keep
    // winning for ordinary names, which is what makes the test262 `assert`
    // harness (`function assert(){}` + `assert.sameValue = …`) fire at all.
    const got = await runStandalone(`function base() { return 1 }
(base as any).sameValue = function (a, b) { return a === b ? 55 : -1 };
var f: any = base;
export function test(): number { return f.sameValue(2, 2); }`);
    expect(got).toBe(55);
  });

  it("a plain function expression value dispatches through .call too", async () => {
    const got = await runStandalone(`var holder = { fn: function (a) { return a * 2 } };
var g: any = holder.fn;
export function test(): number { return g.call(null, 21); }`);
    expect(got).toBe(42);
  });
});
