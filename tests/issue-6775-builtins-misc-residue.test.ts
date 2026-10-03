// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6775 — ES2015 standalone built-ins misc residue: one pin per implemented
// step of the plan (`plan/issues/6775-es2015-standalone-builtins-misc-residue.md`).
// Each probe asserts the spec answer; every probe FAILS on the base sources
// (before-state recorded in the issue file). Probe sources live in
// `.tmp/6775/pins/` during development and are inlined here.
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

const PROBES: { name: string; what: string; expected: number; source: string }[] = [
  {
    name: "s1",
    what: "S1 \u2014 get Error.prototype.stack answers undefined for a Proxy / plain receiver; a dynamic stack read reaches the accessor",
    expected: 7,
    source:
      "var __r = 0;\nvar get = Object.getOwnPropertyDescriptor(Error.prototype, 'stack').get;\nif (get.call(new Proxy(new Error('inner'), {})) === undefined) __r |= 1;\nif (get.call({}) === undefined) __r |= 2;\nif (Reflect.get(new Error('x'), 'stack', {}) === undefined) __r |= 4;\nexport function readResult() { return __r; }\n",
  },
  {
    name: "s2",
    what: "S2 \u2014 the stack setter on a Proxy receiver: gOPD undefined takes CreateDataProperty, own stack takes [[Set]]; trap throw/false propagate",
    expected: 15,
    source:
      "var __r = 0;\nvar set = Object.getOwnPropertyDescriptor(Error.prototype, 'stack').set;\nvar log = [];\nvar pE = new Proxy({ stack: 'old' }, {\n  getOwnPropertyDescriptor: function (t, k) { log.push('g'); return Object.getOwnPropertyDescriptor(t, k); },\n  set: function (t, k, v) { log.push('s'); t[k] = v; return true; },\n  defineProperty: function (t, k, d) { log.push('d'); return Reflect.defineProperty(t, k, d); } });\nset.call(pE, 'new');\nif (log.join() === 'g,s') __r |= 1;\nvar log2 = [];\nvar p1 = new Proxy({}, {\n  getOwnPropertyDescriptor: function (t, k) { log2.push('g'); return Object.getOwnPropertyDescriptor(t, k); },\n  defineProperty: function (t, k, d) { log2.push('d'); return Reflect.defineProperty(t, k, d); },\n  set: function () { log2.push('S'); return true; } });\nset.call(p1, 'x');\nif (log2.join() === 'g,d') __r |= 2;\nvar pC = new Proxy({ stack: 'old' }, { set: function () { throw 7; } });\ntry { set.call(pC, 'v'); } catch (x) { if (x === 7) __r |= 4; }\nvar pB = new Proxy({ stack: 'old' }, { set: function () { return false; } });\ntry { set.call(pB, 'v'); } catch (x) { if (x instanceof TypeError) __r |= 8; }\nexport function readResult() { return __r; }\n",
  },
  {
    name: "s3",
    what: "S3 \u2014 new on the stack getter (a descriptor accessor) throws TypeError",
    expected: 31,
    source:
      "var __r = 0;\nvar get = Object.getOwnPropertyDescriptor(Error.prototype, 'stack').get;\nif (typeof get === 'function') __r |= 1;\ntry { new get(); } catch (e) { __r |= 2; if (e instanceof TypeError) __r |= 4; }\nvar f = function () { new get(); };\ntry { f(); } catch (e) { __r |= 8; if (e instanceof TypeError) __r |= 16; }\nexport function readResult() { return __r; }\n",
  },
  {
    name: "s4a",
    what: "S4 \u2014 JSON.parse ToString of a non-string primitive; a JSON boolean is a boolean; a direct `JSON.parse(x) === v` compare",
    expected: 677202,
    source:
      "var __r = 0;\ntry { JSON.parse(); __r |= 1; } catch (e) { if (e instanceof SyntaxError) __r |= 2; else __r |= 4; }\ntry { JSON.parse(undefined); __r |= 8; } catch (e) { if (e instanceof SyntaxError) __r |= 16; else __r |= 32; }\ntry { if (JSON.parse(null) === null) __r |= 64; } catch (e) { __r |= 128; }\ntry { if (JSON.parse(false) === false) __r |= 256; } catch (e) { __r |= 512; }\ntry { if (JSON.parse(true) === true) __r |= 1024; } catch (e) { __r |= 2048; }\ntry { if (JSON.parse(0) === 0) __r |= 4096; } catch (e) { __r |= 8192; }\ntry { if (JSON.parse(3.14) === 3.14) __r |= 16384; } catch (e) { __r |= 32768; }\ntry { JSON.parse(Symbol('desc')); __r |= 65536; } catch (e) { if (e instanceof TypeError) __r |= 131072; else __r |= 262144; }\ntry { if (JSON.parse('1') === 1) __r |= 524288; } catch (e) { __r |= 1048576; }\nexport function readResult() { return __r; }\n",
  },
  {
    name: "s4b",
    what: "S4 \u2014 a provably non-callable, non-array replacer ('' / 0 / true / Symbol()) is ignored",
    expected: 1361,
    source:
      "var __r = 0;\nvar obj = { key: [1] };\nvar json = '{\"key\":[1]}';\nfunction id(x) { return x; }\ntry { if (JSON.stringify(obj, null) === json) __r |= 1; } catch (e) { __r |= 2; }\ntry { if (JSON.stringify(obj, '') === json) __r |= 16; } catch (e) { __r |= 32; }\ntry { if (JSON.stringify(obj, 0) === json) __r |= 64; } catch (e) { __r |= 128; }\ntry { if (JSON.stringify(obj, true) === json) __r |= 256; } catch (e) { __r |= 512; }\ntry { if (JSON.stringify(obj, Symbol()) === json) __r |= 1024; } catch (e) { __r |= 2048; }\nexport function readResult() { return __r; }\n",
  },
  {
    name: "s4c",
    what: "S4 \u2014 a Proxy value whose length trap throws is observed inside the try (no struct copy at the binding)",
    expected: 2,
    source:
      "var __r = 0;\nfunction T262() {}\nvar abruptLength = new Proxy([], { get: function (_t, key) { if (key === 'length') throw new T262(); } });\ntry { JSON.stringify(abruptLength); __r |= 1; } catch (e) { if (e instanceof T262) __r |= 2; else __r |= 4; }\nexport function readResult() { return __r; }\n",
  },
  {
    name: "s4d",
    what: "S4 \u2014 a Proxy replacer is classified before a primitive root is serialised",
    expected: 18,
    source:
      "var __r = 0;\nfunction T262() {}\nvar abruptLength = new Proxy([], { get: function (_t, key) { if (key === 'length') throw new T262(); } });\ntry { JSON.stringify(null, abruptLength); __r |= 1; } catch (e) { if (e instanceof T262) __r |= 2; else __r |= 4; }\nvar abruptToPrimitive = { valueOf: function () { throw new T262(); } };\nvar abruptToLength = new Proxy([], { get: function (_t, key) { if (key === 'length') return abruptToPrimitive; } });\ntry { JSON.stringify([], abruptToLength); __r |= 8; } catch (e) { if (e instanceof T262) __r |= 16; else __r |= 32; }\nexport function readResult() { return __r; }\n",
  },
  {
    name: "s5a",
    what: "S5 \u2014 Symbol.for applies ToString (ToPrimitive \u2192 user toString, Symbol \u2192 TypeError)",
    expected: 1321,
    source:
      "var __r = 0;\ntry { if (Symbol.for('k') === Symbol.for('k')) __r |= 1; } catch (e) { __r |= 2; }\ntry { var subject = { toString: function () { throw new RangeError('t'); } }; Symbol.for(subject); __r |= 4; } catch (e) { if (e instanceof RangeError) __r |= 8; else __r |= 16; }\ntry { var s2 = { toString: function () { return 'k'; } }; if (Symbol.for(s2) === Symbol.for('k')) __r |= 32; } catch (e) { __r |= 64; }\ntry { Symbol.for(Symbol('s')); __r |= 128; } catch (e) { if (e instanceof TypeError) __r |= 256; else __r |= 512; }\ntry { if (Symbol.keyFor(Symbol.for(1)) === '1') __r |= 1024; } catch (e) { __r |= 2048; }\nexport function readResult() { return __r; }\n",
  },
  {
    name: "s5b",
    what: "S5 \u2014 sym() / new Object(sym)() throw TypeError; Object(sym) inherits from Symbol.prototype",
    expected: 873618,
    source:
      "var __r = 0;\nvar sym = Symbol('desc');\ntry { sym(); __r |= 1; } catch (e) { if (e instanceof TypeError) __r |= 2; else __r |= 4; }\ntry { new sym(); __r |= 8; } catch (e) { if (e instanceof TypeError) __r |= 16; else __r |= 32; }\nvar symObj = Object(Symbol());\ntry { symObj(); __r |= 64; } catch (e) { if (e instanceof TypeError) __r |= 128; else __r |= 256; }\ntry { new symObj(); __r |= 512; } catch (e) { if (e instanceof TypeError) __r |= 1024; else __r |= 2048; }\ntry { if (Object.getPrototypeOf(Symbol('66')).constructor === Symbol) __r |= 4096; } catch (e) { __r |= 8192; }\ntry { if (Object.getPrototypeOf(Object(Symbol('66'))).constructor === Symbol) __r |= 16384; } catch (e) { __r |= 32768; }\ntry { if (Object.getPrototypeOf(Object(Symbol('66'))) === Symbol.prototype) __r |= 65536; } catch (e) { __r |= 131072; }\ntry { var p = Object.getPrototypeOf(Symbol('66')); if (p === Symbol.prototype) __r |= 262144; if (p.constructor === Symbol) __r |= 524288; } catch (e) { __r |= 1048576; }\nexport function readResult() { return __r; }\n",
  },
  {
    name: "s5c",
    what: "S5 \u2014 recv[Symbol.toPrimitive]() on a symbol / Symbol wrapper answers the symbol",
    expected: 2901,
    source:
      "var __r = 0;\ntry { if (Object(Symbol.toPrimitive)[Symbol.toPrimitive]() === Symbol.toPrimitive) __r |= 1; } catch (e) { __r |= 2; }\ntry { if (Symbol.toPrimitive[Symbol.toPrimitive]() === Symbol.toPrimitive) __r |= 4; } catch (e) { __r |= 8; }\ntry { var s = Symbol('x'); if (s[Symbol.toPrimitive]() === s) __r |= 16; } catch (e) { __r |= 32; }\ntry { var w = Object(Symbol.iterator); if (w[Symbol.toPrimitive]() === Symbol.iterator) __r |= 64; } catch (e) { __r |= 128; }\ntry { var s3 = Symbol('y'); if (s3.toString() === 'Symbol(y)') __r |= 256; if (s3.valueOf() === s3) __r |= 512; } catch (e) { __r |= 1024; }\ntry { if (Symbol.iterator.description === 'Symbol.iterator') __r |= 2048; } catch (e) { __r |= 4096; }\nexport function readResult() { return __r; }\n",
  },
  {
    name: "s6a",
    what: "S6 \u2014 ArrayBuffer.prototype.slice.call(x) brand-checks the receiver and slices a real buffer",
    expected: 511,
    source:
      'var __r = 0;\nfunction t(f, bit) { try { f(); } catch (e) { if (e instanceof TypeError) __r |= bit; } }\nt(function () { ArrayBuffer.prototype.slice.call({}); }, 1);\nt(function () { ArrayBuffer.prototype.slice.call([]); }, 2);\nt(function () { ArrayBuffer.prototype.slice.call(undefined); }, 4);\nt(function () { ArrayBuffer.prototype.slice.call(null); }, 8);\nt(function () { ArrayBuffer.prototype.slice.call(true); }, 16);\nt(function () { ArrayBuffer.prototype.slice.call(""); }, 32);\nt(function () { ArrayBuffer.prototype.slice.call(Symbol()); }, 64);\nt(function () { ArrayBuffer.prototype.slice.call(1); }, 128);\nif (ArrayBuffer.prototype.slice.call(new ArrayBuffer(4), 1).byteLength === 3) __r |= 256;\nexport function readResult() { return __r; }\n',
  },
  {
    name: "s6b",
    what: "S6 \u2014 getPrototypeOf(<ArrayBuffer>) / slice species lanes answer ArrayBuffer.prototype; NT.prototype non-object falls back",
    expected: 1023,
    source:
      "var __r = 0;\nfunction t(bit, f) { try { if (f()) __r |= bit; } catch (e) { __r |= bit * 4096; } }\nt(1, function () { var ab = new ArrayBuffer(8); return Object.getPrototypeOf(ab) === ArrayBuffer.prototype; });\nt(2, function () { var ab = new ArrayBuffer(8); var s = ab.slice(); return Object.getPrototypeOf(s) === ArrayBuffer.prototype; });\nt(4, function () { var ab = new ArrayBuffer(8); return Object.getPrototypeOf(ab.slice(1)) === ArrayBuffer.prototype; });\nt(8, function () { var sc = {}; sc[Symbol.species] = undefined; var a2 = new ArrayBuffer(8); a2.constructor = sc; return Object.getPrototypeOf(a2.slice()) === ArrayBuffer.prototype; });\nt(16, function () { var a3 = new ArrayBuffer(8); a3.constructor = undefined; return Object.getPrototypeOf(a3.slice()) === ArrayBuffer.prototype; });\nfunction nt() {}\nt(32, function () { nt.prototype = undefined; var r1 = Reflect.construct(ArrayBuffer, [1], nt); return Object.getPrototypeOf(r1) === ArrayBuffer.prototype; });\nt(64, function () { nt.prototype = 1; var r1 = Reflect.construct(ArrayBuffer, [1], nt); return Object.getPrototypeOf(r1) === ArrayBuffer.prototype; });\nt(128, function () { var anyv = [new ArrayBuffer(2)][0]; return Object.getPrototypeOf(anyv) === ArrayBuffer.prototype; });\nt(256, function () { return new ArrayBuffer(2).slice() instanceof ArrayBuffer; });\nt(512, function () { return Object.getPrototypeOf(new Uint8Array(2)) === Uint8Array.prototype; });\nexport function readResult() { return __r; }\n",
  },
  {
    name: "s6c",
    what: "S6 \u2014 Reflect.construct(ArrayBuffer, [huge], NT) reads NT.prototype before allocating",
    expected: 5,
    source:
      'var __r = 0;\nfunction DummyError() {}\nvar newTarget = function() {}.bind(null);\nvar calls = 0;\nObject.defineProperty(newTarget, "prototype", { get: function() { calls++; throw new DummyError(); } });\ntry { Reflect.construct(ArrayBuffer, [7 * 1125899906842624], newTarget); } catch (e) { if (e instanceof DummyError) __r |= 1; if (e instanceof RangeError) __r |= 2; }\nif (calls === 1) __r |= 4;\nexport function readResult() { return __r; }\n',
  },
  {
    name: "s7a",
    what: "S7 \u2014 dv.constructor walks %DataView.prototype% (not Object); getPrototypeOf(dv) identity",
    expected: 993,
    source:
      'var __r = 0;\nvar dv = new DataView(new ArrayBuffer(8), 0);\nvar c = dv.constructor;\nif (c === DataView) __r |= 1;\nif (c === Object) __r |= 2;\nif (c === ArrayBuffer) __r |= 8;\nif (c === undefined) __r |= 16;\nif (typeof c === "function") __r |= 32;\nif (DataView.prototype.constructor === DataView) __r |= 64;\nif (Object.getPrototypeOf(dv) === DataView.prototype) __r |= 128;\nif (Object.getPrototypeOf(dv).constructor === DataView) __r |= 256;\nif (c === Object.getPrototypeOf(dv).constructor) __r |= 512;\nif (c === Array) __r |= 1024;\nexport function readResult() { return __r; }\n',
  },
  {
    name: "s7b",
    what: "S7 \u2014 a NewTarget.prototype getter that detaches the buffer makes Reflect.construct(DataView, \u2026) throw TypeError (node's 25 reflects the shim, which does not really detach)",
    expected: 26,
    source:
      'var __r = 0;\nfunction $DETACHBUFFER(buf) { if (buf == null) { return; } buf.__detached__ = true; }\nvar buffer = new ArrayBuffer(8);\nvar called = false;\nvar byteOffset = { valueOf() { called = true; return 0; } };\nvar newTarget = function() {}.bind(null);\nObject.defineProperty(newTarget, "prototype", { get() { $DETACHBUFFER(buffer); return DataView.prototype; } });\ntry { Reflect.construct(DataView, [buffer, byteOffset], newTarget); __r |= 1; } catch (e) { if (e instanceof TypeError) __r |= 2; else __r |= 4; }\nif (called) __r |= 8;\nvar b2 = new ArrayBuffer(8);\nvar nt2 = function() {}.bind(null);\nObject.defineProperty(nt2, "prototype", { get() { return DataView.prototype; } });\ntry { var d2 = Reflect.construct(DataView, [b2, 2], nt2); if (d2.byteLength === 6) __r |= 16; } catch (e) { __r |= 32; }\nexport function readResult() { return __r; }\n',
  },
  {
    name: "s8a",
    what: "S8 \u2014 Date.prototype.toJSON generic body: ToObject throw, ToPrimitive(number), non-finite \u2192 null, Invoke toISOString",
    expected: 127,
    source:
      "var __r = 0;\nvar toJSON = Date.prototype.toJSON;\nfunction t(bit, f) { try { if (f()) __r |= bit; } catch (e) { __r |= bit * 4096; } }\nt(1, function () { try { toJSON.call(undefined); return false; } catch (e) { return e instanceof TypeError; } });\nt(2, function () { try { toJSON.call(null); return false; } catch (e) { return e instanceof TypeError; } });\nNumber.prototype.toISOString = function () { return 'str'; };\nt(4, function () { return toJSON.call(10) === 'str'; });\nt(8, function () { return toJSON.call(NaN) === null; });\nt(16, function () { return toJSON.call({ valueOf: function () { return Infinity; }, toISOString: function () { return 1; } }) === null; });\nvar result = new Boolean(false);\nvar obj = { toISOString: function () { return result; } };\nvar cc = 0;\nobj[Symbol.toPrimitive] = function (h) { cc++; return 3.14; };\nt(32, function () { return Date.prototype.toJSON.call(obj) === result && cc === 1; });\nt(64, function () { return new Date(0).toJSON() === '1970-01-01T00:00:00.000Z'; });\nexport function readResult() { return __r; }\n",
  },
  {
    name: "s8b",
    what: "S8 \u2014 toJSON.call(Symbol()) invokes Symbol.prototype.toISOString on the wrapper",
    expected: 1,
    source:
      "var __r = 0;\nvar toJSON = Date.prototype.toJSON;\nSymbol.prototype.toISOString = function () { return 10; };\nvar r;\ntry { r = toJSON.call(Symbol()); if (r === 10) __r |= 1; else if (r === null) __r |= 2; else if (r === undefined) __r |= 4; } catch (e) { __r |= 8; }\nexport function readResult() { return __r; }\n",
  },
  {
    name: "s10",
    what: "S10 \u2014 new C(msg) for an Error-family ctor held in a value builds a real error with its own message",
    expected: 63,
    source:
      "var __r = 0;\nvar ctors = [EvalError, RangeError, ReferenceError, SyntaxError, TypeError, URIError];\nfor (var i = 0; i < ctors.length; i++) {\n  try {\n    var e = new ctors[i]('m');\n    if (e.message === 'm' && e.hasOwnProperty('message')) __r |= 1 << i;\n  } catch (x) { __r |= 4096 << i; }\n}\nexport function readResult() { return __r; }\n",
  },
  {
    name: "s11",
    what: "S11 \u2014 '<target> = yield' inside try/finally suspends into a spill; .return() skips the assignment",
    expected: 15,
    source:
      "var __r = 0;\nvar obj = { foo: 'not modified' };\nfunction* g() { try { obj.foo = yield; } finally { return 1; } }\nvar iter = g();\niter.next();\nvar result = iter.return(45).value;\nif (obj.foo === 'not modified') __r |= 1;\nif (result === 1) __r |= 2;\nvar o2 = { a: 0, b: 0 };\nfunction* g2() { o2.a = yield; o2.b = yield 5; }\nvar it2 = g2(); it2.next(); it2.next(3); it2.next(4);\nif (o2.a === 3 && o2.b === 4) __r |= 4;\nvar o3 = { c: 0 };\nfunction* g3() { try { o3.c = yield; } finally { o3.d = 1; } }\nvar it3 = g3(); it3.next(); it3.next(7);\nif (o3.c === 7 && o3.d === 1) __r |= 8;\nexport function readResult() { return __r; }\n",
  },
  {
    name: "s14",
    what: "S14 \u2014 C[Symbol.species] for class C extends <species owner> answers C",
    expected: 85,
    source:
      "var __r = 0;\nclass MyRegExp extends RegExp {}\ntry { if (MyRegExp[Symbol.species] === MyRegExp) __r |= 1; } catch (e) { __r |= 2; }\ntry { if (RegExp[Symbol.species] === RegExp) __r |= 4; } catch (e) { __r |= 8; }\nclass MyArr extends Array {}\ntry { if (MyArr[Symbol.species] === MyArr) __r |= 16; } catch (e) { __r |= 32; }\nclass MyMap extends Map {}\ntry { if (MyMap[Symbol.species] === MyMap) __r |= 64; } catch (e) { __r |= 128; }\nexport function readResult() { return __r; }\n",
  },
  {
    name: "s18",
    what: "S18 \u2014 Function.prototype.toString.call(<proxy>): callable \u2192 native source, non-callable \u2192 TypeError",
    expected: 337,
    source:
      "var __r = 0;\ntry { var s = Function.prototype.toString.call(new Proxy(class {}, {})); if (typeof s === 'string' && s.indexOf('[native code]') >= 0) __r |= 1; else if (s === '[object Function]') __r |= 2; } catch (e) { __r |= 4; }\ntry { Function.prototype.toString.call(new Proxy({}, {})); __r |= 8; } catch (e) { if (e instanceof TypeError) __r |= 16; else __r |= 32; }\ntry { var s2 = Function.prototype.toString.call(new Proxy(function () {}, {})); if (s2.indexOf('[native code]') >= 0) __r |= 64; } catch (e) { __r |= 128; }\ntry { var f = function () {}; if (typeof Function.prototype.toString.call(f) === 'string') __r |= 256; } catch (e) { __r |= 512; }\nexport function readResult() { return __r; }\n",
  },
  {
    name: "s16a",
    what: "S16 \u2014 %Function.prototype% own name/length {w:F,e:F,c:T}; @@hasInstance {w:F,e:F,c:F} named [Symbol.hasInstance]",
    expected: 85,
    source:
      "var __r = 0;\nvar FP = Function.prototype;\ntry { var d = Object.getOwnPropertyDescriptor(FP, 'name'); if (d && d.value === '' && !d.writable && !d.enumerable && d.configurable) __r |= 1; } catch (e) { __r |= 2; }\ntry { if (typeof FP[Symbol.hasInstance] === 'function') __r |= 4; } catch (e) { __r |= 8; }\ntry { var d2 = Object.getOwnPropertyDescriptor(FP, Symbol.hasInstance); if (d2 && !d2.writable && !d2.enumerable && !d2.configurable) __r |= 16; } catch (e) { __r |= 32; }\ntry { var d3 = Object.getOwnPropertyDescriptor(FP[Symbol.hasInstance], 'name'); if (d3 && d3.value === '[Symbol.hasInstance]') __r |= 64; } catch (e) { __r |= 128; }\nexport function readResult() { return __r; }\n",
  },
  {
    name: "s16b",
    what: "S16 \u2014 f[Symbol.hasInstance](o) runs an own prototype getter (its throw propagates)",
    expected: 18,
    source:
      "var __r = 0;\nvar f = Object.getOwnPropertyDescriptor({ get f() {} }, 'f').get;\nObject.defineProperty(f, 'prototype', { get: function () { throw new RangeError('p'); } });\ntry { f[Symbol.hasInstance]({}); __r |= 1; } catch (e) { if (e instanceof RangeError) __r |= 2; else if (e instanceof TypeError) __r |= 4; else __r |= 8; }\nfunction h() {}\ntry { if (h[Symbol.hasInstance](new h()) === true) __r |= 16; } catch (e) { __r |= 32; }\nexport function readResult() { return __r; }\n",
  },
];

describe("#6775 ES2015 standalone built-ins misc residue", () => {
  for (const p of PROBES) {
    it(`${p.name}: ${p.what}`, { timeout: 120_000 }, async () => {
      expect(await run(p.source)).toBe(p.expected);
    });
  }
});
