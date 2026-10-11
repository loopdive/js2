// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6769 — ES2015 standalone TypedArray residue: one pin per probe of the plan
// (`plan/issues/6769-es2015-standalone-typedarray-residue.md`), each asserting
// the node answer. Every probe uses the test262 harness SHAPE that matters here
// — `TA` a PARAMETER (a `$__ta_ctor` carrier) and `sample` a function-local
// `var` — because the call-site two-arm only fires for an identifier receiver
// held in an externref local; a module-level binding measures a different
// lowering.
//
// WHICH PINS HAVE TEETH. Every probe case FAILS on the base sources (the
// before-state is recorded in the issue file); the three guards at the bottom
// answer the same on both trees. Three probes carry a MASK: the bits it excludes
// are recorded residuals with their mechanism named in the issue file, and the
// mask keeps the pin honest about exactly what this change delivers.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function run(source: string): Promise<number> {
  const r = await compile(source, {
    target: "standalone",
    fileName: "p.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
  } as Parameters<typeof compile>[1]);
  const { instance } = await WebAssembly.instantiate(
    r.binary,
    (r as { importObject?: WebAssembly.Imports }).importObject ?? {},
  );
  const ex = instance.exports as { __module_init?: () => void; readResult: () => number };
  ex.__module_init?.();
  return ex.readResult();
}

const PROBES: { name: string; what: string; expected: number; mask: number | null; source: string }[] = [
  {
    name: "p1",
    what: "S4 — dyn-view map/filter run on the LIVE receiver (callback arg 3, arguments[2], Reflect.set inside the callback, live reads)",
    expected: 127,
    mask: null,
    source: `// p1 — map/filter callback 3rd arg identity + Reflect.set / element writes during iteration
// (harness shape: TA is a parameter, \`sample\` a function-local var)
var __r = 0;
function body(TA) {
  var sample = new TA([42, 43, 44]);
  var third = null;
  sample.map(function(v, i, arr) { third = arr; return 0; });
  if (third === sample) __r |= 1;
  var results = [];
  sample.map(function() { results.push(arguments); return 0; });
  if (results.length === 3 && results[0].length === 3 && results[0][2] === sample) __r |= 2;
  var ok = true;
  sample.map(function(v, i) { if (!Reflect.set(sample, i, i + 10)) ok = false; return 0; });
  if (ok) __r |= 4;
  if (sample[0] === 10 && sample[2] === 12) __r |= 8;
  var seen = -1;
  sample.map(function(v, i) { if (i === 1) seen = sample[0]; if (i === 0) sample[0] = 99; return 0; });
  if (seen === 99) __r |= 16;
  var f3 = null;
  sample.filter(function(v, i, arr) { f3 = arr; return true; });
  if (f3 === sample) __r |= 32;
  var fres = [];
  sample.filter(function() { fres.push(arguments); });
  if (fres.length === 3 && fres[1][2] === sample && fres[1][1] === 1) __r |= 64;
}
body(Float64Array);
export function readResult() { return __r; }
`,
  },
  {
    name: "p2",
    what: "S4/S5 — static-carrier species results; a species view over the same buffer reads the forward byte copy [20,20,20,60]",
    expected: 501,
    mask: null,
    source: `// p2 — species results that are another carrier / same-buffer overlap / computed-key literal
// (harness shape: TA parameter, locals)
var __r = 0;
function body(TA) {
  var sample = new TA([40]);
  var other = new Int8Array([1, 0, 1]);
  sample.constructor = {};
  sample.constructor[Symbol.species] = function() { return other; };
  try { if (sample.subarray(0, 0) === other) __r |= 1; } catch (e) { __r |= 2; }
  try { if (sample.slice(0, 0) === other) __r |= 4; } catch (e) { __r |= 8; }
  var ta = new TA([10, 20, 30, 40, 50, 60]);
  var called = 0;
  ta.constructor = { [Symbol.species]: function() { called++; return new TA(ta.buffer, 2 * TA.BYTES_PER_ELEMENT); } };
  var res = ta.slice(1, 4);
  if (called === 1) __r |= 16;
  if (res.length === 4) __r |= 32;
  if (res[0] === 20 && res[1] === 20 && res[2] === 20 && res[3] === 60) __r |= 64;
  var o = { [Symbol.species]: 7 };
  if (o[Symbol.species] === 7) __r |= 128;
  var other2 = new TA([1, 0, 1]);
  var s2 = new TA([40]);
  s2.constructor = {};
  s2.constructor[Symbol.species] = function() { return other2; };
  try { if (s2.subarray(0, 0) === other2) __r |= 256; } catch (e) { __r |= 512; }
}
body(Float64Array);
export function readResult() { return __r; }
`,
  },
  {
    name: "p2d",
    what: "S2 — a [Symbol.species] literal member is a real symbol-keyed own property (bit 32, a dynamic read of an [Symbol.iterator] literal member, is a recorded residual)",
    expected: 2047,
    mask: 2015,
    source: `// p2d — which object-literal shapes lose a function-valued computed Symbol key for a dynamic read
var __r = 0;
function get(o, k) { return o[k]; }
function isFn(x) { return typeof x === "function"; }
var f = function() { return 1; };
var a = { [Symbol.species]: function() { return 1; } };
var b = { [Symbol.species]() { return 1; } };
var c = { [Symbol.species]: f };
var d = { x: 1, [Symbol.species]: function() { return 1; } };
var e = { [Symbol.species]: function() { return 1; }, x: 1 };
var g = { [Symbol.iterator]: function() { return 1; } };
var h = { [Symbol.toPrimitive]: function() { return 1; } };
if (isFn(get(a, Symbol.species))) __r |= 1;
if (isFn(get(b, Symbol.species))) __r |= 2;
if (isFn(get(c, Symbol.species))) __r |= 4;
if (isFn(get(d, Symbol.species))) __r |= 8;
if (isFn(get(e, Symbol.species))) __r |= 16;
if (isFn(get(g, Symbol.iterator))) __r |= 32;
if (isFn(get(h, Symbol.toPrimitive))) __r |= 64;
if (isFn(a[Symbol.species])) __r |= 128;
if (Object.getOwnPropertySymbols(a).length === 1) __r |= 256;
if (isFn(Reflect.get(a, Symbol.species))) __r |= 512;
var ctorLike = { [Symbol.species]: function() { return 1; } };
function speciesOf(C) { var S = C[Symbol.species]; return S; }
if (isFn(speciesOf(ctorLike))) __r |= 1024;
export function readResult() { return __r; }
`,
  },
  {
    name: "p3",
    what: "S3/S4 — view instanceof TA / %TypedArray%, including map on a non-identifier receiver",
    expected: 8191,
    mask: null,
    source: `// p3 — instanceof / constructor / prototype on derived views (harness shape)
var __r = 0;
var TypedArray = Object.getPrototypeOf(Int8Array);
function body(TA) {
  var s = new TA([1, 2, 3]);
  if (s instanceof TA) __r |= 1;
  if (s.subarray(1) instanceof TA) __r |= 2;
  if (s.map(function(x) { return x; }) instanceof TA) __r |= 4;
  var e = new TA(0);
  var em = e.map(function() {});
  if (em instanceof TA) __r |= 8;
  if (em.constructor === TA) __r |= 16;
  if (Object.getPrototypeOf(em) === Object.getPrototypeOf(e)) __r |= 32;
  if (em.buffer !== e.buffer) __r |= 64;
  if (s instanceof TypedArray) __r |= 128;
  var al = new TA({ length: 2, 0: 1, 1: 2 });
  if (al instanceof TA) __r |= 256;
  if (Object.getPrototypeOf(s.subarray(1)) === TA.prototype) __r |= 512;
  if (s.subarray(1).constructor === TA) __r |= 1024;
  var pos = new TA([1]).map(function(x) { return x; });
  if (pos instanceof TA) __r |= 2048;
}
body(Float64Array);
var st = new Float64Array([1]);
if (st instanceof Float64Array) __r |= 4096;
export function readResult() { return __r; }
`,
  },
  {
    name: "p5c",
    what: "S7 — %TypedArray% / %TypedArray%.prototype receivers (bits 8/16 — a getter read off a descriptor binding that was ASSIGNED, not initialised — are a recorded residual)",
    expected: 1397581,
    mask: 2097127,
    source: `// p5c — every statement of the invoked-as rows, individually try-wrapped
var __r = 0;
var TypedArray = Object.getPrototypeOf(Int8Array);
var TypedArrayPrototype = TypedArray.prototype;
var desc;
try { desc = Object.getOwnPropertyDescriptor(TypedArrayPrototype, Symbol.toStringTag); if (desc !== undefined) __r |= 1; } catch (e) { __r |= 2; }
try { var getter = desc.get; if (typeof getter === "function") __r |= 4; if (getter() === undefined) __r |= 8; } catch (e) { __r |= 16; }
try { TypedArrayPrototype.length; __r |= 32; } catch (e) { if (e instanceof TypeError) __r |= 64; }
try { TypedArrayPrototype.byteLength; __r |= 128; } catch (e) { if (e instanceof TypeError) __r |= 256; }
try { if (typeof TypedArrayPrototype.join === "function") __r |= 512; } catch (e) { __r |= 1024; }
try { TypedArrayPrototype.join(); __r |= 2048; } catch (e) { if (e instanceof TypeError) __r |= 4096; }
try { TypedArray(); __r |= 8192; } catch (e) { if (e instanceof TypeError) __r |= 16384; }
try { new TypedArray(); __r |= 32768; } catch (e) { if (e instanceof TypeError) __r |= 65536; }
try { new TypedArray(1); __r |= 131072; } catch (e) { if (e instanceof TypeError) __r |= 262144; }
try { TypedArray({}); __r |= 524288; } catch (e) { if (e instanceof TypeError) __r |= 1048576; }
export function readResult() { return __r; }
`,
  },
  {
    name: "p6a",
    what: "S8 — an excessive array-like / count length is a RangeError, not a trap",
    expected: 21,
    mask: null,
    source: `// p6a — excessive array-like length must be a catchable RangeError, not a wasm trap
var __r = 0;
var obj = { length: Math.pow(2, 53) };
function body(TA) {
  try { new TA(obj); } catch (e) { if (e instanceof RangeError) __r |= 1; else __r |= 2; }
  try { new TA({ length: 0x7fffffff }); } catch (e) { if (e instanceof RangeError) __r |= 4; else __r |= 8; }
  try { new TA(0x7fffffff); } catch (e) { if (e instanceof RangeError) __r |= 16; else __r |= 32; }
}
body(Float64Array);
export function readResult() { return __r; }
`,
  },
  {
    name: "p6f",
    what: "S10 — Object.getPrototypeOf(<ArrayBuffer carrier>) === ArrayBuffer.prototype",
    expected: 16383,
    mask: 8369,
    source: `// p6f — prototype identity of ArrayBuffer carriers: a literal \`new ArrayBuffer\`, a view's \`.buffer\`, a dyn view's \`.buffer\`
var __r = 0;
var ab = new ArrayBuffer(8);
if (Object.getPrototypeOf(ab) === ArrayBuffer.prototype) __r |= 1;
if (ab instanceof ArrayBuffer) __r |= 2;
if (ab.constructor === ArrayBuffer) __r |= 4;
var v = new Uint8Array(ab);
if (v.buffer === ab) __r |= 8;
if (Object.getPrototypeOf(v.buffer) === ArrayBuffer.prototype) __r |= 16;
var w = new Uint8Array(4);
if (Object.getPrototypeOf(w.buffer) === ArrayBuffer.prototype) __r |= 32;
if (w.buffer instanceof ArrayBuffer) __r |= 64;
function body(TA) {
  var s = new TA(4);
  var b = s.buffer;
  if (Object.getPrototypeOf(b) === ArrayBuffer.prototype) __r |= 128;
  if (b instanceof ArrayBuffer) __r |= 256;
  if (b.constructor === ArrayBuffer) __r |= 512;
  if (ArrayBuffer.isView(s)) __r |= 1024;
  if (b.byteLength === 4 * TA.BYTES_PER_ELEMENT) __r |= 2048;
  var s2 = new TA(ab);
  if (s2.buffer === ab) __r |= 4096;
  if (Object.getPrototypeOf(s2.buffer) === ArrayBuffer.prototype) __r |= 8192;
}
body(Float64Array);
export function readResult() { return __r; }
`,
  },
  {
    name: "p8",
    what: "S6 — dyn-view sort: -0 before +0, numeric order, NaN last, comparator ToNumber",
    expected: 127,
    mask: null,
    source: `// p8 — %TypedArray%.prototype.sort on a dynamic view
var __r = 0;
function mk(TA, a) { return new TA(a); }
var s = mk(Float64Array, [1, 0, -0, 2]).sort();
if (Object.is(s[0], -0) && Object.is(s[1], 0)) __r |= 1;
var s2 = mk(Float64Array, [20, 100, 3]).sort();
if (s2[0] === 3 && s2[1] === 20 && s2[2] === 100) __r |= 2;
var saved = Number.prototype.toString; var tsCalled = false;
Number.prototype.toString = function() { tsCalled = true; };
var s3 = mk(Float64Array, [20, 100, 3]).sort();
Number.prototype.toString = saved;
if (!tsCalled && s3[0] === 3) __r |= 4;
var called = false;
var s4 = mk(Float64Array, [3, 1, 2]);
s4.sort(function(a, b) { return { [Symbol.toPrimitive]: function() { called = true; return a - b; } }; });
if (called) __r |= 8;
if (s4[0] === 1 && s4[2] === 3) __r |= 16;
var s5 = mk(Int8Array, [4, 3, 2, 1]).sort();
if (s5[0] === 1 && s5[3] === 4) __r |= 32;
var s6 = mk(Float64Array, [3, NaN, 1]).sort();
if (s6[0] === 1 && s6[1] === 3 && s6[2] !== s6[2]) __r |= 64;
export function readResult() { return __r; }
`,
  },
  {
    name: "p9",
    what: "S1 — __any_unbox_bool(null) is false (a filter predicate returning undefined/null)",
    expected: 3,
    mask: null,
    source: `// p9 — filter predicate returning every falsy value (harness shape)
var __r = 0;
function body(TA) {
  var sample = new TA(3);
  var ok = 0;
  [false, "", 0, -0, NaN, undefined, null].forEach(function(val) {
    var result = sample.filter(function() { return val; });
    if (result.length === 0) ok++;
  });
  if (ok === 7) __r |= 1;
}
body(Float64Array);
var ok2 = 0;
[false, "", 0, -0, NaN, undefined, null].forEach(function(val) { var r = [1, 2, 3].filter(function() { return val; }); if (r.length === 0) ok2++; });
if (ok2 === 7) __r |= 2;
export function readResult() { return __r; }
`,
  },
  {
    name: "s7c",
    what: "S7c — a direct call of a binding holding a descriptor's accessor reaches the accessor (built-in and user getters; a missing getter still throws TypeError)",
    expected: 674121,
    mask: null,
    source: `// s7c — \`var g = Object.getOwnPropertyDescriptor(o, k).get; g()\` (the test262 invoked-as-func idiom)
var __r = 0;
var TypedArray = Object.getPrototypeOf(Int8Array);
var TAP = TypedArray.prototype;
var tagGetter = Object.getOwnPropertyDescriptor(TAP, Symbol.toStringTag).get;
try { if (tagGetter() === undefined) __r |= 1; } catch (e) { __r |= 2; }
var lenGetter = Object.getOwnPropertyDescriptor(TAP, "length").get;
try { lenGetter(); __r |= 4; } catch (e) { if (e instanceof TypeError) __r |= 8; else __r |= 16; }
var bufGetter = Object.getOwnPropertyDescriptor(TAP, "buffer").get;
try { bufGetter(); __r |= 32; } catch (e) { if (e instanceof TypeError) __r |= 64; else __r |= 128; }
var userGetter = Object.getOwnPropertyDescriptor({ get x() { return 5; } }, "x").get;
try { if (userGetter() === 5) __r |= 256; } catch (e) { __r |= 512; }
var noGetter = Object.getOwnPropertyDescriptor({ x: 1 }, "x").get;
try { noGetter(); __r |= 1024; } catch (e) { if (e instanceof TypeError) __r |= 2048; else __r |= 4096; }
var abGetter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength").get;
try { abGetter(); __r |= 8192; } catch (e) { if (e instanceof TypeError) __r |= 16384; else __r |= 32768; }
var dvGetter = Object.getOwnPropertyDescriptor(DataView.prototype, "byteOffset").get;
try { dvGetter(); __r |= 65536; } catch (e) { if (e instanceof TypeError) __r |= 131072; else __r |= 262144; }
var d2 = Object.getOwnPropertyDescriptor(TAP, Symbol.toStringTag);
var g2 = d2.get;
try { if (g2() === undefined) __r |= 524288; } catch (e) { __r |= 1048576; }
export function readResult() { return __r; }
`,
  },
];

describe("#6769 — probe pins (node answers; red on the base sources)", () => {
  for (const p of PROBES) {
    it(`${p.name}: ${p.what}`, { timeout: 180_000 }, async () => {
      const got = await run(p.source);
      if (p.mask === null) expect(got).toBe(p.expected);
      else expect(got & p.mask).toBe(p.expected & p.mask);
    });
  }
});

const GUARDS: { name: string; expected: number; source: string }[] = [
  {
    name: "static Float64Array comparator sort",
    expected: 1,
    source: `var __r = 0;
function f() {
  var u = new Float64Array([20, 100, 3]);
  u.sort(function (a, b) { return a - b; });
  if (u[0] === 3 && u[1] === 20 && u[2] === 100) __r |= 1;
}
f();
export function readResult() { return __r; }
`,
  },
  {
    name: "static map with a species set through the assignment form",
    expected: 3,
    source: `var __r = 0;
var ta = new Int8Array([1, 2, 3]);
var calls = 0;
ta.constructor = {};
ta.constructor[Symbol.species] = function (n) { calls++; return new Int8Array(n); };
var m = ta.map(function (x) { return x * 2; });
if (m.length === 3 && m[2] === 6) __r |= 1;
if (calls <= 1) __r |= 2;
export function readResult() { return __r; }
`,
  },
  {
    name: "Array filter",
    expected: 1,
    source: `var __r = 0;
if ([1, 2, 3].filter(function (x) { return x > 1; }).length === 2) __r |= 1;
export function readResult() { return __r; }
`,
  },
];

describe("#6769 — guards (same answer on base and branch)", () => {
  for (const g of GUARDS) {
    it(g.name, { timeout: 180_000 }, async () => {
      expect(await run(g.source)).toBe(g.expected);
    });
  }
});
