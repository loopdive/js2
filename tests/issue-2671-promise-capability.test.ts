// (#2671) Promise capability-constructor slice #2 — three stacked gaps that
// made the whole `Promise.{all,allSettled,race,any}.call(Constructor, [thenable])`
// test262 family fail at parser^W capability setup:
//
//   1. COMPILER — a top-level `F.<prop> = …` static write on a function
//      DECLARATION was silently dropped from `__module_init`
//      (`collectEmptyObjectWidening`'s keep-in-init check only recognized
//      module-global roots — declarations.ts). `Test262Error.thrower = fn`
//      (the real sta.js shape) therefore never existed at runtime.
//   2. HARNESS — the synthesized test262 prelude's `Test262Error` class lacked
//      the real sta.js `thrower` static entirely (added as a static METHOD,
//      which marshals host-callable when passed as a value).
//   3. HOST RUNTIME — a wasm object-literal THENABLE element
//      (`{ then: function (onFulfilled, onRejected) {…} }`) crossed into the
//      native combinator as a RAW struct: V8's PerformPromiseAll
//      `Invoke(C.resolve(elem), "then", «resolveElement, reject»)` found no
//      `.then` and rejected the aggregate. `_toIterable` now wraps ONLY
//      then-bearing structs in the `_wrapForHost` live-mirror proxy
//      (non-thenable elements pass through raw — fulfilled-value identity
//      for `Promise.all([obj])` is preserved).
//
// Flips 28 `built-ins/Promise` files (the `new-resolve-function` /
// `same-{resolve,reject}-function` / `resolve-element-function-*` /
// `reject-element-function-*` / `invoke-resolve-on-*` families). The sibling
// shapes whose `Constructor` declares a CAPTURING inner resolve remain failing
// under #2976 (per-reference closure identity) — see the issue files.

import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runHost(source: string, fn = "test"): Promise<unknown> {
  const result = await compile(source, { fileName: "t.ts" });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setExports?.(instance.exports as Record<string, Function>);
  return (instance.exports as Record<string, (...a: unknown[]) => unknown>)[fn]();
}

describe("#2671 Promise capability slice 2 — statics + thenable element marshaling", () => {
  it("top-level fn-decl static write survives to runtime (was: dropped from __module_init)", async () => {
    const v = await runHost(`// @ts-nocheck
function MyErr(msg) { this.message = msg; }
MyErr.num = 42;
MyErr.fn = function () { return 7; };
export function test() {
  var viaCall = "?";
  try { viaCall = "ret:" + MyErr.fn(); } catch (e) { viaCall = "threw"; }
  return MyErr.num + "|" + viaCall;
}
`);
    expect(v).toBe("42|ret:7");
  });

  it("capability ctor with fn-static thrower arg creates the capability (was: 'not callable')", async () => {
    const v = await runHost(`// @ts-nocheck
var log = "";
function MyErr(msg) { this.message = msg; }
MyErr.thrower = function (msg) { throw new MyErr(msg); };
function Constructor(executor) {
  log = log + "entered|";
  executor(function () {}, MyErr.thrower);
  log = log + "returned|";
}
Constructor.resolve = function (v) { return v; };
export function test() {
  try { Promise.all.call(Constructor, []); log = log + "all-ok"; }
  catch (e) { log = log + "threw:" + (e && e.message ? e.message : e); }
  return log;
}
`);
    expect(v).toBe("entered|returned|all-ok");
  });

  it("wasm thenable element's then is invoked with the native resolve-element fn", async () => {
    const v = await runHost(`// @ts-nocheck
var log = "";
function Constructor(executor) {
  executor(function () {}, function () {});
}
export function test() {
  Constructor.resolve = function (v) { log = log + "C.resolve|"; return v; };
  var p1 = {
    then: function (onFulfilled, onRejected) {
      log = log + "p1.then:" + typeof onFulfilled + "|";
    }
  };
  Promise.all.call(Constructor, [p1]);
  return log;
}
`);
    // C.resolve consulted per element AND the thenable's then invoked with a
    // host-callable resolve-element function.
    expect(v).toBe("C.resolve|p1.then:function|");
  });
});
