// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6736 — `.length` on an untyped (`any`) receiver in `--target standalone`
 * must be the real Get: `undefined` when the object has no `length`.
 *
 * The standalone lowering answered a number for every receiver (the array-like
 * `__extern_length` reader turns an absent `length` into 0), so a constructor's
 * `prototype` object — lodash's `LazyWrapper.prototype` — read `length === 0`,
 * `isArrayLike` answered true, and lodash's module init threw
 * `called value is not a function` from `arrayLikeKeys`.
 */
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

async function runStandalone(source: string): Promise<number> {
  const result = await compile(source, {
    target: "standalone",
    allowJs: true,
    fileName: "any-length.js",
    emitWat: false,
    runtimeEvalProvider: false,
  } as Parameters<typeof compile>[1]);
  expect(result.success, JSON.stringify(result.errors?.slice(0, 3))).toBe(true);
  const module = new WebAssembly.Module(result.binary!);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = new WebAssembly.Instance(module, {});
  return (instance.exports.run as () => number)();
}

/** The issue's reduction: lodash's `runInContext` + `baseCreate` shape. */
const LODASH_LAZY_WRAPPER = `
var out = 0;
function ric(context) {
  var Object = context.Object;
  var objectCreate = Object.create;
  function isObject(v) { var t = typeof v; return v != null && (t == 'object' || t == 'function'); }
  var baseCreate = (function () {
    function object() {}
    return function (proto) {
      if (!isObject(proto)) return {};
      if (objectCreate) return objectCreate(proto);
      object.prototype = proto; var r = new object; object.prototype = undefined; return r;
    };
  }());
  function baseLodash() {}
  function lodash(value) { return value; }
  lodash.prototype = baseLodash.prototype;
  lodash.prototype.constructor = lodash;
  function LazyWrapper(value) { this.__wrapped__ = value; }
  LazyWrapper.prototype = baseCreate(baseLodash.prototype);
  LazyWrapper.prototype.constructor = LazyWrapper;
  var len = LazyWrapper.prototype.length;
  if (len === undefined) out += 1;
  if (typeof len === 'number') out += 2;
  if (typeof baseLodash.prototype.length === 'undefined') out += 4;
}
ric(globalThis);
export function run() { return out; }
`;

/** lodash's `isArrayLike` over absent and present `length` receivers. */
const IS_ARRAY_LIKE = `
var out = 0;
function isLength(value) {
  return typeof value == 'number' && value > -1 && value % 1 == 0 && value <= 9007199254740991;
}
function isFunction(value) { return typeof value == 'function'; }
function isArrayLike(value) { return value != null && isLength(value.length) && !isFunction(value); }
function F() {}
function G() {}
G.prototype = Object.create(F.prototype);
function id(v) { return v; }
if (!isArrayLike(id(F.prototype))) out += 1;
if (!isArrayLike(id(G.prototype))) out += 2;
if (isArrayLike(id([1, 2]))) out += 4;
if (isArrayLike(id('ab'))) out += 8;
if (!isArrayLike(id({}))) out += 16;
if (isArrayLike(id({ length: 3 }))) out += 32;
if (!isArrayLike(id(function (a) {}))) out += 64;
export function run() { return out; }
`;

/** Present lengths keep their value; absent ones read undefined, own or inherited. */
const LENGTH_VALUES = `
var out = 0;
function id(v) { return v; }
var two = id(function (a, b) {});
if (two.length === 2) out += 1;
if (id([1, 2, 3]).length === 3) out += 2;
if (id('abcd').length === 4) out += 4;
if (id(Object.keys({ a: 1, b: 2 })).length === 2) out += 8;
if (id(new Uint8Array(5)).length === 5) out += 16;
if (id(Math.max).length === 2) out += 32;
if (id(Object.create({ length: 9 })).length === 9) out += 64;
if (typeof id({}).length === 'undefined') out += 128;
if (typeof id(two.prototype).length === 'undefined') out += 256;
export function run() { return out; }
`;

/**
 * The re-land condition: a spread call into an `arguments`-reading callee must
 * put the spread VALUES into `arguments`, not the `$AnyValue` union structs that
 * carry them. With the old numeric `.length`, test262's `compareArray` compared
 * two equally wrong reads and passed by coincidence
 * (`harness/compare-array-arguments.js`); once `.length` became the real Get the
 * row failed. The direct calls (bits 8/16/32 and 64/128) are the anti-vacuity
 * control: they pass with and without the fix.
 */
const SPREAD_INTO_ARGUMENTS = `
var out = 0;
function f(base) {
  if (arguments[1] === 0) out += base;
  if (arguments[2] === 'a') out += base * 2;
  if (typeof arguments[1] === 'number') out += base * 4;
}
var v3 = [0, 'a'];
f(1, ...v3);
f(8, 0, 'a');
function g() {
  if (arguments[0] === 0) out += 64;
  if (arguments[1] === 'a') out += 128;
}
g(0, 'a');
g(...v3);
function same(a, b) {
  if (a === b) return a !== 0 || 1 / a === 1 / b;
  return a !== a && b !== b;
}
function compareArray(a, b) {
  if (b.length !== a.length) return false;
  for (var i = 0; i < a.length; i++) if (!same(b[i], a[i])) return false;
  return true;
}
const fixture = [0, 'a', undefined];
function h() {
  if (compareArray(arguments, fixture)) out += 512;
  if (compareArray(fixture, arguments)) out += 1024;
}
h(...fixture);
export function run() { return out; }
`;

/**
 * PR #6506 merge-group park: the real Get must stay confined to ordinary
 * objects. Routing every non-closure receiver through `__extern_get` broke 79
 * standalone test262 rows: a length-tracking TypedArray view read its raw -1
 * sentinel, a detached view its stale length, a rest-args array `undefined`, and
 * a String wrapper `undefined`. These carriers keep `__extern_length`.
 * Bits 32/128/256 (a fixed view, `{ length: 7 }`, two literal arrays) are the
 * anti-vacuity control: they pass with and without the fix. Node answers 1023.
 */
const NON_OBJECT_CARRIERS = `
var out = 0;
function compareArray(a, b) {
  if (b.length !== a.length) return false;
  for (var i = 0; i < a.length; i++) if (b[i] !== a[i]) return false;
  return true;
}
if (compareArray(((...args) => args)(), [])) out += 1;
if (compareArray(((...args) => args)(1, 2, 3), [1, 2, 3])) out += 2;
var seen = false;
Array.prototype.forEach.call(new String("012"), function (val, idx, obj) { seen = obj.length === 3; });
if (seen) out += 4;
var tracked = 0, detached = 0, fixedOk = 0;
function each(f) {
  var ctors = [Float64Array, Uint8Array];
  for (var i = 0; i < ctors.length; i++) f(ctors[i]);
}
each(function (TA) {
  var rab = new ArrayBuffer(4 * TA.BYTES_PER_ELEMENT, { maxByteLength: 8 * TA.BYTES_PER_ELEMENT });
  var ta = new TA(rab);
  if (ta.length === 4) tracked += 1;
  rab.resize(6 * TA.BYTES_PER_ELEMENT);
  if (ta.length === 6) tracked += 1;
  var buf = new ArrayBuffer(3 * TA.BYTES_PER_ELEMENT);
  var fixed = new TA(buf);
  if (fixed.length === 3) fixedOk += 1;
  buf.transfer();
  if (fixed.length === 0) detached += 1;
});
if (tracked === 4) out += 8;
if (detached === 2) out += 16;
if (fixedOk === 2) out += 32;
var proto = (function () { function F() {} return F.prototype; })();
function readLen(o) { return o.length; }
if (typeof readLen(proto) === "undefined") out += 64;
if (readLen({ length: 7 }) === 7) out += 128;
if (compareArray([1, 2], [1, 2])) out += 256;
var result = false;
function callbackfn(val, idx, obj) { result = (obj.length === 3); }
Array.prototype.forEach.call(new String("012"), callbackfn);
if (result) out += 512;
export function run() { return out; }
`;

describe("#6736 standalone `.length` on an any receiver is the real Get", () => {
  it("non-object carriers keep their own length (TypedArray views, rest arrays, String wrappers)", async () => {
    expect(await runStandalone(NON_OBJECT_CARRIERS)).toBe(1023);
  });

  it("a spread call puts the spread values themselves into `arguments`", async () => {
    expect(await runStandalone(SPREAD_INTO_ARGUMENTS)).toBe(1983);
  });

  it("a constructor's prototype object has no length (lodash LazyWrapper)", async () => {
    expect(await runStandalone(LODASH_LAZY_WRAPPER)).toBe(5);
  });

  it("lodash isArrayLike: prototype objects and plain objects are not array-like", async () => {
    expect(await runStandalone(IS_ARRAY_LIKE)).toBe(127);
  });

  it("present lengths are unchanged; absent ones read undefined", async () => {
    expect(await runStandalone(LENGTH_VALUES)).toBe(511);
  });
});
