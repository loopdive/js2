// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 cluster H, slice H6) Array methods over a Proxy receiver, standalone.
 *
 * Two mechanisms, both the F-cluster shape — a representation chosen by the
 * SPELLING's static type where the question is the VALUE:
 *
 * 1. The standalone array-like substrate (`__extern_length` /
 *    `__extern_get_idx` / `__extern_has_idx`) had an arm for an array-like
 *    `$Object` but not for a `$Proxy`, so §7.3.18 LengthOfArrayLike answered 0
 *    for every proxy: a REVOKED proxy never threw, and `[1].concat(<proxy over
 *    [7, 8]>)` had length 1.
 * 2. TypeScript types a proxy as its target array, so the borrow compiler sent
 *    `Array.prototype.{slice,splice}.call(p)` and `[].concat(p)` to typed
 *    lowerings that `ref.cast` the operand to a vec — an `illegal cast` trap,
 *    or a call on a materialized copy.
 *
 * Measured on this branch's base (`885a45051`), standalone: every "RED on
 * base" pin below fails there; every guard answers the same on both trees.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/** Compile `body` as module-scope JavaScript; return the `__h6` value. */
async function runModuleScopeJs(body: string): Promise<number> {
  const source = `var __h6 = 0;\n${body}\nexport function readResult() { return __h6; }\n`;
  const result = await compile(source, {
    target: "standalone",
    fileName: "issue-6651-h6.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.imports ?? [], "standalone module must import nothing").toEqual([]);
  expect(WebAssembly.validate(result.binary), "module failed WebAssembly.validate").toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, result.importObject);
  const exports = instance.exports as { __module_init?: () => void; readResult: () => number };
  exports.__module_init?.();
  return exports.readResult();
}

/** `1` when `call` throws a TypeError, `2` for another throw, `0` for none. */
const throwsTypeError = (call: string): string =>
  `(function () { try { ${call}; return 0; } catch (e) { return e instanceof TypeError ? 1 : 2; } })()`;

describe("#6651 H6 — LengthOfArrayLike / Get / HasProperty through a Proxy", () => {
  it("RED on base (no throw): map.call over a REVOKED proxy throws before reading `constructor`", async () => {
    expect(
      await runModuleScopeJs(`
      var o = Proxy.revocable([], {});
      var ctorCount = 0;
      Object.defineProperty(o.proxy, "constructor", { get: function () { ctorCount += 1; } });
      o.revoke();
      __h6 = ${throwsTypeError("Array.prototype.map.call(o.proxy, function () {})")} * 10 + ctorCount;`),
    ).toBe(10);
  });

  it("RED on base (length 1): concat spreads a live proxy over an array by its trapped length", async () => {
    expect(
      await runModuleScopeJs(`
      var r;
      r = [1].concat(new Proxy([7, 8], {}));
      __h6 = (r.length === 3 ? 1 : 0) + (r[1] === 7 ? 2 : 0) + (r[2] === 8 ? 4 : 0);`),
    ).toBe(7);
  });

  it("RED on base (illegal cast): concat of a REVOKED proxy throws the IsConcatSpreadable TypeError", async () => {
    expect(
      await runModuleScopeJs(`
      var handle = Proxy.revocable([], {});
      handle.revoke();
      __h6 = ${throwsTypeError("[].concat(handle.proxy)")};`),
    ).toBe(1);
  });
});

describe("#6651 H6 — slice/splice.call on a Proxy value take the array-like algorithm", () => {
  it("RED on base (illegal cast): slice.call over a REVOKED proxy throws a TypeError", async () => {
    expect(
      await runModuleScopeJs(`
      var o = Proxy.revocable([], {});
      o.revoke();
      __h6 = ${throwsTypeError("Array.prototype.slice.call(o.proxy)")};`),
    ).toBe(1);
  });

  it("RED on base (no throw): splice.call over a REVOKED proxy throws a TypeError", async () => {
    expect(
      await runModuleScopeJs(`
      var o = Proxy.revocable([], {});
      o.revoke();
      __h6 = ${throwsTypeError("Array.prototype.splice.call(o.proxy)")};`),
    ).toBe(1);
  });

  it("RED on base: slice/splice.call over a LIVE proxy read and write through it", async () => {
    expect(
      await runModuleScopeJs(`
      var s;
      s = Array.prototype.slice.call(new Proxy([1, 2, 3, 4], {}), 1, 3);
      var q = new Proxy([5, 6, 7], {});
      var sp;
      sp = Array.prototype.splice.call(q, 0, 2);
      __h6 = (s.length === 2 ? 1 : 0) + (s[0] === 2 ? 2 : 0) + (s[1] === 3 ? 4 : 0) +
        (sp.length === 2 ? 8 : 0) + (sp[0] === 5 ? 16 : 0) + (q.length === 1 ? 32 : 0) + (q[0] === 7 ? 64 : 0);`),
    ).toBe(127);
  });
});

describe("#6651 H6 — a Proxy binding handed to an Array borrow stays a proxy", () => {
  it("RED on base: map/filter/concat/slice/splice.call consult @@species through a proxy over an array", async () => {
    expect(
      await runModuleScopeJs(`
      var array = [];
      var proxy = new Proxy(new Proxy(array, {}), {});
      var Ctor = function () {};
      array.constructor = function () {};
      array.constructor[Symbol.species] = Ctor;
      var r1, r2, r3;
      r1 = Array.prototype.map.call(proxy, function () {});
      r2 = Array.prototype.filter.call(proxy, function () {});
      r3 = Array.prototype.concat.call(proxy);
      var r4, r5;
      r4 = Array.prototype.slice.call(proxy);
      r5 = Array.prototype.splice.call(proxy);
      __h6 = (Object.getPrototypeOf(r1) === Ctor.prototype ? 1 : 0) +
        (Object.getPrototypeOf(r2) === Ctor.prototype ? 2 : 0) +
        (Object.getPrototypeOf(r3) === Ctor.prototype ? 4 : 0) +
        (Object.getPrototypeOf(r4) === Ctor.prototype ? 8 : 0) +
        (Object.getPrototypeOf(r5) === Ctor.prototype ? 16 : 0);`),
    ).toBe(31);
  });

  it("RED on base (trap at the declaration): a trapped length of 2**32 is ArrayCreate's RangeError", async () => {
    expect(
      await runModuleScopeJs(`
      var array = [];
      var sets = 0;
      var handler = {
        get: function (_, name) { return name === "length" ? Math.pow(2, 32) : array[name]; },
        set: function () { sets += 1; return true; },
      };
      var p1 = new Proxy(array, handler);
      var p2 = new Proxy(array, handler);
      var p3 = new Proxy(array, handler);
      function rangeError(f) { try { f(); return 0; } catch (e) { return e instanceof RangeError ? 1 : 2; } }
      __h6 = rangeError(function () { Array.prototype.slice.call(p1); }) +
        rangeError(function () { Array.prototype.splice.call(p2, 0); }) * 10 +
        rangeError(function () { Array.prototype.map.call(p3, function () {}); }) * 100 + sets * 1000;`),
    ).toBe(111);
  });

  it("RED on base (TypeError): copyWithin.call runs a proxy's has / deleteProperty traps", async () => {
    expect(
      await runModuleScopeJs(`
      var p1 = new Proxy({ 0: 42, length: 1 }, { has: function () { throw new RangeError("has"); } });
      var p2 = new Proxy({ 42: true, length: 43 }, {
        deleteProperty: function (t, k) { if (k === "42") { throw new RangeError("delete"); } return true; },
      });
      function rangeError(f) { try { f(); return 0; } catch (e) { return e instanceof RangeError ? 1 : 2; } }
      __h6 = rangeError(function () { Array.prototype.copyWithin.call(p1, 0, 0); }) +
        rangeError(function () { Array.prototype.copyWithin.call(p2, 42, 0); }) * 10;`),
    ).toBe(11);
  });
});

describe("#6651 H6 — guards: receivers that are not proxies answer as before", () => {
  it("Object.getPrototypeOf of a genuine array in a species-observable module", async () => {
    expect(
      await runModuleScopeJs(`
      var a = [1, 2];
      a.constructor = {};
      var m;
      m = [3].map(function (x) { return x; });
      var s = [4, 5].slice(1);
      __h6 = (Object.getPrototypeOf(a) === Array.prototype ? 1 : 0) +
        (Object.getPrototypeOf(m) === Array.prototype ? 2 : 0) +
        (Object.getPrototypeOf(s) === Array.prototype ? 4 : 0);`),
    ).toBe(7);
  });

  it("an array-like object through map/slice/splice.call", async () => {
    expect(
      await runModuleScopeJs(`
      var o = { 0: 3, 1: 4, length: 2 };
      var m;
      m = Array.prototype.map.call(o, function (x) { return x * 2; });
      var s;
      s = Array.prototype.slice.call({ 0: 5, 1: 6, length: 2 }, 1);
      __h6 = (m.length === 2 ? 1 : 0) + (m[1] === 8 ? 2 : 0) + (s.length === 1 ? 4 : 0) + (s[0] === 6 ? 8 : 0);`),
    ).toBe(15);
  });

  it("plain arrays through slice/splice/concat in a module that mentions Proxy", async () => {
    expect(
      await runModuleScopeJs(`
      var unused = typeof Proxy;
      var a = [1, 2, 3, 4];
      var s = a.slice(1, 3);
      var sp = a.splice(0, 1);
      var c = [0].concat(a);
      __h6 = s.length * 1000 + sp[0] * 100 + c.length * 10 + a.length;`),
    ).toBe(2000 + 100 + 40 + 3);
  });

  it("a Proxy-free module: array-likes keep their length", async () => {
    expect(
      await runModuleScopeJs(`
      var o = { 0: "a", length: 1 };
      var n = 0;
      Array.prototype.forEach.call(o, function () { n += 1; });
      __h6 = n;`),
    ).toBe(1);
  });
});
