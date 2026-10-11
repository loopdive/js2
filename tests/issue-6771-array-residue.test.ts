// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6771) ES2015 standalone `built-ins/Array/**` residue — one pin per
 * mechanism the issue's probe table measures, each asserting node's answer
 * (bit masks; every bit is one observable the row family checks).
 *
 * "RED on base" cases fail on `origin/main` without the #6771 branch (base
 * verdict recorded in the issue file, measured by swapping `src/`); "guard"
 * cases answer the same on both trees. Bits whose mechanism is out of scope
 * are left out of the probe body and named in the issue's residual list
 * instead of being asserted wrong here.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/** Compile `body` as module-scope JavaScript (standalone) and return `__r`. */
async function run(body: string, strict = false): Promise<number> {
  const source = `${strict ? '"use strict";\n' : ""}var __r = 0;\n${body}\nexport function readResult() { return __r; }\n`;
  const result = await compile(source, {
    target: "standalone",
    fileName: "issue-6771.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.imports ?? [], "standalone module must import nothing").toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, result.importObject);
  const exports = instance.exports as { __module_init?: () => void; readResult: () => number };
  exports.__module_init?.();
  return exports.readResult();
}

describe("#6771 S1 — Proxy receivers: species, ArrayCreate RangeError, copyWithin", () => {
  it("RED on base: ArraySpeciesCreate through a double Proxy receiver (slice/map/filter/splice/concat)", async () => {
    expect(
      await run(`
      var array = [];
      var proxy = new Proxy(new Proxy(array, {}), {});
      var Ctor = function() {};
      array.constructor = function() {};
      array.constructor[Symbol.species] = Ctor;
      if (Object.getPrototypeOf(Array.prototype.slice.call(proxy)) === Ctor.prototype) __r |= 1;
      if (Object.getPrototypeOf(Array.prototype.map.call(proxy, function() {})) === Ctor.prototype) __r |= 2;
      if (Object.getPrototypeOf(Array.prototype.filter.call(proxy, function() {})) === Ctor.prototype) __r |= 4;
      if (Object.getPrototypeOf(Array.prototype.splice.call(proxy)) === Ctor.prototype) __r |= 8;
      if (Object.getPrototypeOf(Array.prototype.concat.call(proxy)) === Ctor.prototype) __r |= 16;
      var arr2 = []; arr2.constructor = {}; arr2.constructor[Symbol.species] = Ctor;
      if (Object.getPrototypeOf(arr2.slice()) === Ctor.prototype) __r |= 32;
      if (Object.getPrototypeOf(arr2.map(function() {})) === Ctor.prototype) __r |= 64;
      if (Object.getPrototypeOf(arr2.concat()) === Ctor.prototype) __r |= 128;`),
    ).toBe(255);
  });

  it("RED on base (trap): a trapped length of 2^32 is ArrayCreate's RangeError, before any Set or callback", async () => {
    expect(
      await run(`
      var array = [];
      var maxLength = Math.pow(2, 32);
      var cb = 0, sets = 0;
      var proxy = new Proxy(array, {
        get: function(t, name) { if (name === 'length') return maxLength; return array[name]; },
        set: function() { sets++; return true; }
      });
      try { Array.prototype.map.call(proxy, function() { cb++; }); } catch (e) { if (e instanceof RangeError) __r |= 1; }
      if (sets === 0 && cb === 0) __r |= 2;
      try { Array.prototype.splice.call(proxy, 0); } catch (e) { if (e instanceof RangeError) __r |= 4; }
      try { Array.prototype.slice.call(proxy); } catch (e) { if (e instanceof RangeError) __r |= 8; }
      if (sets === 0) __r |= 16;`),
    ).toBe(31);
  });

  it("RED on base (trap): concat of a Proxy operand whose length is 2^53-1 throws a TypeError", async () => {
    expect(
      await run(`
      var pbig = new Proxy([], { get: function(t, k) { if (k === "length") return Number.MAX_SAFE_INTEGER; } });
      try { [].concat(1, pbig); } catch (e) { if (e instanceof TypeError) __r |= 1; }`),
    ).toBe(1);
  });

  it("RED on base: copyWithin.call over a plain array-like and a Proxy (has / deleteProperty traps run)", async () => {
    expect(
      await run(`
      var o3 = { 0: 1, 1: 2, 2: 3, length: 3 };
      try { var r3 = Array.prototype.copyWithin.call(o3, 0, 1); if (r3 === o3 && o3[0] === 2 && o3[1] === 3 && o3[2] === 3) __r |= 4; } catch (e) { __r |= 4096; }
      var o = { '0': 42, length: 1 };
      var p = new Proxy(o, { has: function(t, k) { throw new Error("has"); } });
      try { Array.prototype.copyWithin.call(p, 0, 0); } catch (e) { if (e.message === "has") __r |= 1; else if (e instanceof TypeError) __r |= 1024; }
      var o2 = { '42': true, length: 43 };
      var p2 = new Proxy(o2, { deleteProperty: function(t, k) { if (k === '42') throw new Error("del"); } });
      try { Array.prototype.copyWithin.call(p2, 42, 0); } catch (e) { if (e.message === "del") __r |= 2; else if (e instanceof TypeError) __r |= 2048; }`),
    ).toBe(7);
  });
});

describe("#6771 S2 — array-like trio over closures, String wrappers, RegExp carriers, a TypedArray's own length", () => {
  it("RED on base: concat spreads a RegExp / Function / String wrapper by its expando indices", async () => {
    expect(
      await run(`
      var re = /abc/;
      re[Symbol.isConcatSpreadable] = true;
      re[0] = 1; re[1] = 2; re[2] = 3; re.length = 3;
      var c1 = [].concat(re);
      if (c1.length === 3) __r |= 1;
      if (c1[0] === 1 && c1[2] === 3) __r |= 2;
      var fn = function(a, b, c) {};
      fn[Symbol.isConcatSpreadable] = true;
      fn[0] = 1; fn[1] = 2; fn[2] = 3;
      var c2 = [].concat(fn);
      if (c2.length === 3) __r |= 4;
      if (c2[0] === 1 && c2[2] === 3) __r |= 8;
      var str1 = new String("yu");
      str1[Symbol.isConcatSpreadable] = true;
      var c3 = [].concat(str1);
      if (c3.length === 2) __r |= 16;
      if (c3[0] === "y" && c3[1] === "u") __r |= 32;`),
    ).toBe(63);
  });

  it("RED on base: ToLength of a `length` whose ToPrimitive throws is abrupt (receiver and operand)", async () => {
    expect(
      await run(`
      var broken = { length: { valueOf: null, toString: null }, 1: "A", 3: "B" };
      broken[Symbol.isConcatSpreadable] = true;
      var obj2 = { 0: "0", 1: "1" };
      try { Array.prototype.concat.call(broken, obj2, ["X"]); } catch (e) { if (e instanceof TypeError) __r |= 1; }
      try { [].concat(broken); } catch (e) { if (e instanceof TypeError) __r |= 2; }
      var big = {};
      big.length = Number.MAX_SAFE_INTEGER;
      big[Symbol.isConcatSpreadable] = true;
      try { [1].concat(big); } catch (e) { if (e instanceof TypeError) __r |= 4; }`),
    ).toBe(7);
  });

  it("RED on base: a String wrapper made spreadable spreads its code units (instance and prototype)", async () => {
    expect(
      await run(`
      var str1 = new String("yuck\\uD83D\\uDCA9");
      var c0 = [].concat(str1);
      if (c0.length === 1) __r |= 1;
      if (c0[0] === str1) __r |= 2;
      str1[Symbol.isConcatSpreadable] = true;
      var c1 = [].concat(str1);
      if (c1.length === 6) __r |= 4;
      if (c1[0] === "y" && c1[4] === "\\uD83D") __r |= 8;
      String.prototype[Symbol.isConcatSpreadable] = true;
      var c2 = [].concat(new String("yuck\\uD83D\\uDCA9"));
      if (c2.length === 6 && c2[3] === "k") __r |= 16;
      var c3 = [].concat("yuck\\uD83D\\uDCA9");
      if (c3.length === 1 && c3[0] === "yuck\\uD83D\\uDCA9") __r |= 32;
      delete String.prototype[Symbol.isConcatSpreadable];`),
    ).toBe(63);
  });

  it("RED on base: RegExp instance and RegExp.prototype index/length writes are what concat spreads", async () => {
    expect(
      await run(`
      var re = /abc/;
      var c0 = [].concat(re);
      if (c0.length === 1) __r |= 1;
      if (c0[0] === re) __r |= 2;
      re[Symbol.isConcatSpreadable] = true;
      re[0] = 1, re[1] = 2, re[2] = 3, re.length = 3;
      var c1 = [].concat(re);
      if (c1.length === 3 && c1[0] === 1 && c1[2] === 3) __r |= 4;
      RegExp.prototype[Symbol.isConcatSpreadable] = true;
      RegExp.prototype.length = 3;
      var c2 = [].concat(/abc/);
      if (c2.length === 3) __r |= 8;
      if (c2[0] === undefined) __r |= 16;
      RegExp.prototype[0] = 1;
      RegExp.prototype[1] = 2;
      RegExp.prototype[2] = 3;
      var c3 = [].concat(/abc/);
      if (c3.length === 3 && c3[0] === 1 && c3[2] === 3) __r |= 32;
      delete RegExp.prototype[Symbol.isConcatSpreadable];
      delete RegExp.prototype[0];
      delete RegExp.prototype[1];
      delete RegExp.prototype[2];
      delete RegExp.prototype.length;
      var c4 = [].concat(/abc/);
      if (c4.length === 1) __r |= 64;`),
    ).toBe(127);
  });

  it("RED on base (compile refusal): index writes on a `var re = /abc/` keep it a RegExp", async () => {
    expect(
      await run(`
      var re = /abc/;
      if (Array.isArray(re) === false) __r |= 1;
      if (re instanceof RegExp) __r |= 2;
      if (re.source === "abc") __r |= 4;
      if (typeof re.exec === "function") __r |= 8;
      var c0 = [].concat(re);
      if (c0.length === 1 && c0[0] === re) __r |= 16;
      re[Symbol.isConcatSpreadable] = true;
      re[0] = 1, re[1] = 2, re[2] = 3, re.length = 3;
      if (Array.isArray(re) === false) __r |= 32;
      if (re.length === 3 && re[0] === 1) __r |= 64;
      var c1 = [].concat(re);
      if (c1.length === 3 && c1[2] === 3) __r |= 128;`),
    ).toBe(255);
  });

  it("RED on base: a TypedArray's own `length` data property is what concat reads (harness shape)", async () => {
    // Bits 2/8/32 of the issue's p2 (a STATIC `ta.length` read, and concat of a
    // module-level Uint8Array binding) are recorded residuals, not asserted.
    expect(
      await run(`
      var ta = new Uint8Array(1);
      ta[Symbol.isConcatSpreadable] = true;
      var c1 = [].concat(ta);
      if (c1.length === 1 && c1[0] === 0) __r |= 1;
      Object.defineProperty(ta, "length", { value: 3 });
      if (Object.prototype.hasOwnProperty.call(ta, "length")) __r |= 4;
      function body(TA) {
        var t = new TA(1);
        Object.defineProperty(t, "length", { value: 3 });
        t[Symbol.isConcatSpreadable] = true;
        var c = [].concat(t);
        if (c.length === 3) __r |= 64;
      }
      body(Float64Array);`),
    ).toBe(69);
  });
});

describe("#6771 S3 — `Array(n)` / `new Array(n)` holes are holes", () => {
  it("RED on base (reads null): a hole of new Array(n) is undefined and absent", async () => {
    expect(
      await run(`
      var nb = new Array(5);
      if (nb.length === 5) __r |= 1;
      if (nb[2] === undefined) __r |= 2;
      if (typeof nb[2] === "undefined") __r |= 4;
      if (nb[2] === 0) __r |= 8;
      if (nb[2] === null) __r |= 16;
      if (!(2 in nb)) __r |= 32;
      var s = String(nb[2]);
      if (s === "undefined") __r |= 64;
      if (s === "0") __r |= 128;
      if (s === "null") __r |= 256;`),
    ).toBe(103);
  });

  it("RED on base: new Array(4000) and a concat of a sparse spreadable read undefined at every index", async () => {
    // p1d3 bits 4/8 (`[].map.call(<holes>, String)` leaving holes) are the
    // pre-existing map-over-holes residual, not asserted.
    expect(
      await run(`
      var na = new Array(4000);
      if (na.length === 4000) __r |= 1;
      if (na[100] === undefined) __r |= 2;
      if (!(100 in na)) __r |= 4;
      if (String(na[100]) === "undefined") __r |= 8;
      var m = [].map.call(na, String); if (m.length === 4000) __r |= 16;
      var obj = { length: 5 };
      obj[Symbol.isConcatSpreadable] = true;
      var c1 = [].concat(obj);
      var bad = 0;
      for (var i = 0; i < 5; i++) if (c1[i] !== undefined) bad++;
      if (bad === 0 && c1.length === 5) __r |= 32;`),
    ).toBe(63);
  });

  it("guard: Array(n) holes render as empty, and the hole searches that answer -1 on both trees", async () => {
    // `indexOf` / `lastIndexOf(undefined)` over a run of holes (`new Array(3)`
    // bound or inline, `[, , ,]`) answers 0 in some module shapes on BOTH trees —
    // a pre-existing, route-dependent defect recorded in the issue, not asserted.
    expect(
      await run(`
      if (Array(3).join(",") === ",,") __r |= 4;
      if (new Array(3).length === 3) __r |= 8;
      if (Array(3).indexOf(undefined) === -1) __r |= 16;
      if (new Array(3).lastIndexOf(undefined) === -1) __r |= 32;
      if ([, 1].indexOf(undefined) === -1) __r |= 64;
      if ([, 1].indexOf(1) === 1) __r |= 128;`),
    ).toBe(252);
  });
});

describe("#6771 S4 — flat / flatMap run ArraySpeciesCreate", () => {
  it("RED on base: flat publishes into the species result with CreateDataPropertyOrThrow", async () => {
    expect(
      await run(`
      var A = function(_len) { this.length = 0; Object.preventExtensions(this); };
      var arr = [1];
      arr.constructor = {};
      arr.constructor[Symbol.species] = A;
      try { arr.flat(1); } catch (e) { if (e instanceof TypeError) __r |= 1; }
      var B = function(_len) { Object.defineProperty(this, "0", { set: function(_v) {}, configurable: false }); };
      var arr2 = [[1]];
      arr2.constructor = {};
      arr2.constructor[Symbol.species] = B;
      try { arr2.flat(1); } catch (e) { if (e instanceof TypeError) __r |= 2; }
      var called = 0;
      var Cc = function(len) { called++; return new Array(len); };
      var arr3 = [1, [2]];
      arr3.constructor = {};
      arr3.constructor[Symbol.species] = Cc;
      var r3 = arr3.flat();
      if (called === 1) __r |= 4;
      if (r3.length === 2 && r3[1] === 2) __r |= 8;`),
    ).toBe(15);
  });

  it("RED on base (compile refusal): flatMap with an array-returning callback and a species constructor", async () => {
    expect(
      await run(`
      var A = function(_len) { this.length = 0; Object.preventExtensions(this); };
      var arr = [[1]];
      arr.constructor = {};
      arr.constructor[Symbol.species] = A;
      try { arr.flatMap(function(item) { return item; }); } catch (e) { if (e instanceof TypeError) __r |= 1; }`),
    ).toBe(1);
  });

  it("guard: flat on a species-free module", async () => {
    expect(await run(`var f = [1, [2, [3]]].flat(); if (f.length === 3 && f[2][0] === 3) __r |= 1;`)).toBe(1);
  });
});

describe("#6771 S5 — Array.prototype[@@unscopables]", () => {
  it("RED on base: an own non-writable, configurable null-prototype object of `true` members", async () => {
    expect(
      await run(`
      var u = Array.prototype[Symbol.unscopables];
      if (typeof u === "object" && u !== null) __r |= 1;
      if (u && Object.getPrototypeOf(u) === null) __r |= 2;
      if (u && u.copyWithin === true && u.keys === true && u.flat === true && u.values === true) __r |= 4;
      if (Object.prototype.hasOwnProperty.call(Array.prototype, Symbol.unscopables)) __r |= 8;
      var d = Object.getOwnPropertyDescriptor(Array.prototype, Symbol.unscopables);
      if (d && d.writable === false && d.enumerable === false && d.configurable === true) __r |= 16;
      if (u) { var d2 = Object.getOwnPropertyDescriptor(u, "copyWithin"); if (d2 && d2.value === true && d2.writable === true && d2.enumerable === true && d2.configurable === true) __r |= 32; }
      var d3 = Object.getOwnPropertyDescriptor(Array.prototype, Symbol.iterator);
      if (d3 && typeof d3.value === "function") __r |= 64;
      if (Object.prototype.hasOwnProperty.call(Array.prototype, Symbol.iterator)) __r |= 128;
      if (typeof Array.prototype[Symbol.iterator] === "function") __r |= 256;`),
    ).toBe(511);
  });
});

describe("#6771 S6 — an overridden Boolean.prototype.toString reaches boolean receivers", () => {
  it("RED on base: data-property override, strict (`this` stays a primitive)", async () => {
    // p6 bit 16 (`[true, "x"].toLocaleString()`, a MIXED element array) is a
    // recorded residual, not asserted.
    expect(
      await run(
        `
      var sep = ["", ""].toLocaleString();
      if (sep === ",") __r |= 1;
      Boolean.prototype.toString = function() { return typeof this; };
      if (true.toString() === "boolean") __r |= 2;
      if (true.toLocaleString() === "boolean") __r |= 4;
      if ([true, false].toLocaleString() === "boolean,boolean") __r |= 8;
      if (String(true) === "true") __r |= 32;`,
        true,
      ),
    ).toBe(47);
  });

  it("RED on base: accessor override, strict", async () => {
    expect(
      await run(
        `
      Object.defineProperty(Boolean.prototype, "toString", {
        get: function() { var v = typeof this; return function() { return v; }; }
      });
      if (true.toString() === "boolean") __r |= 1;
      if (true.toLocaleString() === "boolean") __r |= 2;
      if ([true, false].toLocaleString() === "boolean,boolean") __r |= 4;`,
        true,
      ),
    ).toBe(7);
  });

  it("guard: boolean rendering without an override", async () => {
    expect(
      await run(`if ([true, false].toString() === "true,false") __r |= 1; if (true.toString() === "true") __r |= 2;`),
    ).toBe(3);
  });
});

describe("#6771 S7 — Array.from.call(C, …): Construct(C), MakeConstructor's back-link, Construct(Object)", () => {
  const p7 = (decl: (name: string, init: string) => string) => `
      var thisVal, args, callCount = 0;
      var C = function() { thisVal = this; args = arguments; callCount += 1; };
      var items = {};
      items[Symbol.iterator] = function() { return { next: function() { return { done: true }; } }; };
      ${decl("result", "Array.from.call(C, items)")}
      if (result instanceof C) __r |= 1;
      if (result.constructor === C) __r |= 2;
      if (callCount === 1 && thisVal === result && args.length === 0) __r |= 4;
      var o = new C();
      if (o.constructor === C) __r |= 8;
      if (C.prototype.constructor === C) __r |= 16;
      ${decl("r2", "Array.from.call(Object, [])")}
      if (r2.constructor === Object) __r |= 32;
      var o2 = new Object();
      if (o2.constructor === Object) __r |= 64;
      if (Object.prototype.constructor === Object) __r |= 128;
      if (Object.getPrototypeOf(result) === C.prototype) __r |= 256;
      if (Object.getPrototypeOf(r2) === Object.prototype) __r |= 512;`;

  it("RED on base: `var r = Array.from.call(C, …)` (initialized binding keeps C's object)", async () => {
    expect(await run(p7((n, init) => `var ${n} = ${init};`))).toBe(1023);
  });

  it("RED on base: the same through an assignment to an untyped binding", async () => {
    expect(await run(p7((n, init) => `var ${n}; ${n} = ${init};`))).toBe(1023);
  });

  it("RED on base: Array.of.call(C, …) / reverse.call(O) / copyWithin.call(O, …) bindings keep the value they were given", async () => {
    expect(
      await run(`
      var C = function() {};
      var r = Array.of.call(C, 1, 2);
      if (r instanceof C) __r |= 1;
      if (r.length === 2 && r[1] === 2) __r |= 2;
      var O = { 0: "b", 1: "a", length: 2 };
      var rv = Array.prototype.reverse.call(O);
      if (rv === O) __r |= 4;
      var Q = { 0: 1, 1: 2, 2: 3, length: 3 };
      var cw = Array.prototype.copyWithin.call(Q, 0, 1);
      if (cw === Q && Q[0] === 2) __r |= 8;`),
    ).toBe(15);
  });

  it("guard: new F() instanceof F and Array.from on an array", async () => {
    expect(
      await run(`
      function F() { this.x = 1; }
      var f = new F();
      if (f instanceof F && f.x === 1) __r |= 1;
      var a = Array.from([1, 2]);
      if (Array.isArray(a) && a.length === 2 && a[1] === 2) __r |= 2;`),
    ).toBe(3);
  });
});

describe("#6771 S8/S9 — element fidelity across representation changes", () => {
  it("RED on base: Array.from(array-like) reads an absent index as undefined, not NaN", async () => {
    expect(
      await run(`
      var obj = { 0: 2, 1: 4, 2: 0, 3: 16, length: 4 };
      delete obj[2];
      if (obj[2] === undefined) __r |= 1;
      if (!(2 in obj)) __r |= 2;
      var a = Array.from(obj);
      if (a.length === 4) __r |= 4;
      if (a[2] === undefined) __r |= 8;
      if (a[0] === 2 && a[3] === 16) __r |= 16;
      if (2 in a) __r |= 32;`),
    ).toBe(63);
  });

  it("RED on base: a boolean vec's own element survives an Array.prototype['0'] accessor", async () => {
    expect(
      await run(`
      Object.defineProperty(Array.prototype, "0", { set: function(_v) {}, configurable: true });
      if ([1][0] === 1) __r |= 1;
      if (["a"][0] === "a") __r |= 2;
      if ([true][0] === true) __r |= 4;
      var o = {}; if ([o][0] === o) __r |= 8;
      var f = [1]; if (f[0] === 1) __r |= 16;
      var b = [true]; if (b[0] === true) __r |= 32;
      var b2 = [false, true]; if (b2[1] === true) __r |= 64;
      if (b[0] !== undefined) __r |= 128;
      delete Array.prototype[0];
      var b3 = [true]; if (b3[0] === true) __r |= 256;`),
    ).toBe(511);
  });
});

describe("#6771 S10a/S10b — ArraySetLength converts twice, then checks [[Writable]]", () => {
  it("RED on base: assignment, Reflect.set and defineProperty run both conversions first", async () => {
    // The Reflect.defineProperty half (p3 bits 128/256) waits on the #6770 S4
    // false channel and is not asserted here.
    expect(
      await run(`
      var array = [1, 2, 3];
      var hints = [];
      var length = {};
      length[Symbol.toPrimitive] = function(hint) {
        hints.push(hint);
        Object.defineProperty(array, "length", { writable: false });
        return 0;
      };
      try { (function() { "use strict"; array.length = length; })(); } catch (e) { if (e instanceof TypeError) __r |= 1; }
      if (hints.length === 2) __r |= 2;
      if (hints[0] === "number" && hints[1] === "number") __r |= 4;
      array = [1, 2, 3]; hints = [];
      var rs = Reflect.set(array, "length", length);
      if (rs === false) __r |= 8;
      if (hints.length === 2) __r |= 16;
      var arr2 = [1, 2];
      var calls = 0;
      var len2 = { valueOf: function() { calls++; if (calls !== 1) Object.defineProperty(arr2, "length", { writable: false }); return arr2.length; } };
      try { Object.defineProperty(arr2, "length", { value: len2, writable: true }); } catch (e) { if (e instanceof TypeError) __r |= 32; }
      if (calls === 2) __r |= 64;`),
    ).toBe(127);
  });

  it("guard: ordinary length writes and defines", async () => {
    expect(
      await run(`
      var a = [1, 2, 3];
      a.length = 1;
      if (a.length === 1 && a[1] === undefined) __r |= 1;
      var b = Object.defineProperty([1, 2], "length", { value: 1 });
      if (b.length === 1) __r |= 2;
      try { a.length = -1; } catch (e) { if (e instanceof RangeError) __r |= 4; }`),
    ).toBe(7);
  });
});

describe("#6771 — Proxy / concat guards", () => {
  it("guard: concat of arrays and a Proxy over a plain object", async () => {
    expect(
      await run(`
      var c = [1, 2, 3].concat([4]);
      if (c.length === 4 && c[3] === 4) __r |= 1;
      if (new Proxy({}, {}).x === undefined) __r |= 2;`),
    ).toBe(3);
  });
});
