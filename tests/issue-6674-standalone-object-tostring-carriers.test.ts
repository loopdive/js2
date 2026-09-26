// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6674) `Object.prototype.toString` on an `any` receiver under
 * `--target standalone` must classify the NOMINAL carriers (RegExp, Date, class
 * instances, Symbol, BigInt, Map/Set/WeakMap/WeakSet, Promise, Proxy) and honour
 * a `@@toStringTag` a plain object carries, instead of throwing
 * `Object.prototype.toString is not yet implemented in --target standalone`.
 *
 * moment's standalone-dynamic lane died in module-init on exactly the RegExp row:
 * its locale `set(config)` loop asks `isFunction(prop)` of every config value.
 *
 * Measured on the parent (d76cdfc9b4): 11 of the 24 rows below failed (8 threw
 * the refusal, 3 answered a silent `[object Object]`); with the fix all pass.
 * The CHECKED count guards against a vacuous run (a module that stops early
 * would report 0 failures over fewer rows).
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runRows(body: string): Promise<{ failed: number; checked: number; firstFail: number }> {
  const src = `
var failed = 0; var checked = 0; var firstFail = -1;
function cls(x) { return Object.prototype.toString.call(x); }
function CHK(thunk, want) {
  var got;
  try { got = thunk(); } catch (e) { got = "THREW"; }
  if (got !== want) { failed++; if (firstFail < 0) firstFail = checked; }
  checked++;
}
${body}
export function getFailed() { return failed; }
export function getChecked() { return checked; }
export function getFirstFail() { return firstFail; }
`;
  const result = await compile(src, {
    allowJs: true,
    fileName: "issue-6674.js",
    skipSemanticDiagnostics: true,
    target: "standalone",
    deferTopLevelInit: true,
  });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(result.imports).toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  const ex = instance.exports as Record<string, () => number>;
  (ex.__module_init as () => void)();
  return { failed: ex.getFailed!(), checked: ex.getChecked!(), firstFail: ex.getFirstFail!() };
}

describe("#6674 standalone Object.prototype.toString — nominal carriers", () => {
  it("classifies every carrier through an any-typed receiver", async () => {
    const r = await runRows(`
      CHK(function () { return cls({ a: 1 }); }, "[object Object]");
      CHK(function () { return cls([1, 2]); }, "[object Array]");
      CHK(function () { return cls(function () {}); }, "[object Function]");
      CHK(function () { return cls(5); }, "[object Number]");
      CHK(function () { return cls("s"); }, "[object String]");
      CHK(function () { return cls(true); }, "[object Boolean]");
      CHK(function () { return cls(null); }, "[object Null]");
      CHK(function () { return cls(undefined); }, "[object Undefined]");
      CHK(function () { return cls(new Date(0)); }, "[object Date]");
      CHK(function () { return cls(/a/); }, "[object RegExp]");
      CHK(function () { return cls(new Error("x")); }, "[object Error]");
      CHK(function () { return cls(new TypeError("x")); }, "[object Error]");
      function Loc(c) { this.c = c; }
      CHK(function () { return cls(new Loc(1)); }, "[object Object]");
      class K { constructor() { this.v = 1; } }
      CHK(function () { return cls(new K()); }, "[object Object]");
      CHK(function () { return (function () { return cls(arguments); })(1, 2); }, "[object Arguments]");
      CHK(function () { return cls(Symbol("q")); }, "[object Symbol]");
      CHK(function () { return cls(new Map()); }, "[object Map]");
      CHK(function () { return cls(new Set()); }, "[object Set]");
      CHK(function () { return cls(Promise.resolve(1)); }, "[object Promise]");
      CHK(function () { return cls(Math); }, "[object Math]");
      CHK(function () { return cls(JSON); }, "[object JSON]");
      CHK(function () { var o = {}; o[Symbol.toStringTag] = "Zed"; return cls(o); }, "[object Zed]");
      CHK(function () { return cls(new Number(1)); }, "[object Number]");
      CHK(function () { return cls(10n); }, "[object BigInt]");
    `);
    expect(r.checked).toBe(24);
    expect(r.firstFail).toBe(-1);
    expect(r.failed).toBe(0);
  });

  it("answers a Proxy through IsArray, and still throws for a revoked one", async () => {
    const r = await runRows(`
      CHK(function () { return cls(new Proxy({}, {})); }, "[object Object]");
      CHK(function () { return cls(new Proxy([], {})); }, "[object Array]");
      CHK(function () { return cls(new Proxy(function () {}, {})); }, "[object Function]");
      CHK(function () { var r = Proxy.revocable([], {}); r.revoke(); return cls(r.proxy); }, "THREW");
      CHK(function () { var h = { get: function (t, k) { return k === Symbol.toStringTag ? "Trap" : undefined; } };
                        return cls(new Proxy({}, h)); }, "[object Trap]");
    `);
    expect(r.checked).toBe(5);
    expect(r.firstFail).toBe(-1);
    expect(r.failed).toBe(0);
  });

  it("the moment shape: isFunction / isObject over a locale config with RegExp values", async () => {
    const r = await runRows(`
      function isFunction(input) {
        return (typeof Function !== "undefined" && input instanceof Function) ||
          Object.prototype.toString.call(input) === "[object Function]";
      }
      function isObject(input) {
        return input != null && Object.prototype.toString.call(input) === "[object Object]";
      }
      var config = { ordinal: function (n) { return n + "th"; }, meridiemParse: /[ap]\\.?m?\\.?/i, months: ["a"], week: { dow: 0 } };
      var fnCount = 0; var objCount = 0;
      for (var k in config) { if (isFunction(config[k])) fnCount++; if (isObject(config[k])) objCount++; }
      CHK(function () { return fnCount; }, 1);
      CHK(function () { return objCount; }, 1);
    `);
    expect(r.checked).toBe(2);
    expect(r.failed).toBe(0);
  });
});
