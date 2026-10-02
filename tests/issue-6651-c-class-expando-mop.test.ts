// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #6651 cluster C — a property ASSIGNED onto a class object at module scope (`K.foo = f`) is
// visible to the dynamic object MOP in standalone (`src/codegen/class-object-expando.ts`).
//
// The module-scope write lowers to a `__static_K_foo` global that every TYPED access uses; before
// this slice nothing on the dynamic side (`__extern_get`/`__extern_set`/`in`/hasOwn/gOPD/delete/
// the method-call native) knew the name → global map, so a read through an untyped value answered
// `undefined` and a dynamic write went to a bag the typed read never consults. Every behaviour case
// below is RED on the slice's base; the controls pin what must NOT move (the gc lane and a
// standalone module with no such write never contain the new arms).
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/** Compile a JS test body the way the original-harness runner does, run it, return `out`. */
async function runStandalone(body: string): Promise<number> {
  const result = await compile(`var out = 0;\n${body}\nexport function test() { return out; }\n`, {
    fileName: "issue-6651-c-class-expando.js",
    target: "standalone",
    allowJs: true,
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
  } as Parameters<typeof compile>[1]);
  expect(result.success, result.success ? "" : result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(
    true,
  );
  const module = await WebAssembly.compile(result.binary);
  const imports = WebAssembly.Module.imports(module).filter((entry) => entry.module !== "wasm:js-string");
  expect(imports, "the class-object cell arms must stay host-free").toEqual([]);
  const instance = await WebAssembly.instantiate(module, {});
  const exports = instance.exports as { __module_init?: () => void; test(): number };
  exports.__module_init?.();
  return exports.test();
}

async function watOf(body: string, target: "standalone" | undefined): Promise<string> {
  const result = await compile(`var out = 0;\n${body}\nexport function test() { return out; }\n`, {
    fileName: "issue-6651-c-class-expando.js",
    ...(target ? { target } : {}),
    allowJs: true,
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
  } as Parameters<typeof compile>[1]);
  expect(result.success).toBe(true);
  return result.wat ?? "";
}

/** Each check appends 1 (true) / 2 (false) / 3 (threw) as a decimal digit. */
const PRELUDE = `
function id(x) { return x; }
function t(f) { var r; try { r = f() ? 1 : 2; } catch (e) { r = 3; } out = out * 10 + r; }
function f() { return 42; }
class K {}
K.foo = f;
K.bar = 5;
`;

describe("#6651 C — module-scope class-object cells through the dynamic MOP (standalone)", () => {
  it("a dynamic Get sees a module-scope `K.p = v` (function and number values)", async () => {
    const out = await runStandalone(`${PRELUDE}
t(function () { return id(K).foo === f; });
t(function () { return id(K).bar === 5; });
t(function () { return typeof id(K).foo === "function"; });
t(function () { return Reflect.get(K, "bar") === 5; });
t(function () { var k = id(K); return k["b" + "ar"] === 5; });`);
    expect(out).toBe(11111);
  });

  it("a dynamic Set lands in the same cell the typed read uses", async () => {
    const out = await runStandalone(`${PRELUDE}
t(function () { id(K).bar = 6; return K.bar === 6; });
t(function () { var k = id(K); k["bar"] = 7; return K.bar === 7 && id(K).bar === 7; });
t(function () { K.bar = 8; return id(K).bar === 8; });`);
    expect(out).toBe(111);
  });

  it("presence, descriptor and enumerability answer from the cell", async () => {
    const out = await runStandalone(`${PRELUDE}
var k = id(K);
t(function () { return Object.prototype.hasOwnProperty.call(k, "bar"); });
t(function () { return Object.hasOwn(k, "foo"); });
t(function () { return "bar" in k; });
t(function () {
  var d = Object.getOwnPropertyDescriptor(k, "bar");
  return d !== undefined && d.value === 5 && d.writable === true && d.enumerable === true && d.configurable === true;
});
t(function () { return k.propertyIsEnumerable("bar"); });
t(function () { return !("nope" in k) && id(K).nope === undefined; });`);
    expect(out).toBe(111111);
  });

  it("a method call through an untyped receiver invokes the cell's function with that receiver", async () => {
    const out = await runStandalone(`${PRELUDE}
K.self = function () { return this; };
t(function () { return id(K).foo() === 42; });
t(function () { return id(K)["foo"]() === 42; });
t(function () { return id(K).self() === K; });`);
    expect(out).toBe(111);
  });

  it("delete through an untyped receiver removes the property; a later Set recreates it", async () => {
    const out = await runStandalone(`${PRELUDE}
var k = id(K);
t(function () { return delete k.bar; });
t(function () { return k.bar === undefined && !("bar" in k); });
t(function () { k.bar = 9; return K.bar === 9 && k.bar === 9 && ("bar" in k); });`);
    expect(out).toBe(111);
  });

  it("an `extends Error` / `extends Promise` class object answers the same way", async () => {
    const out = await runStandalone(`
function id(x) { return x; }
function t(f) { var r; try { r = f() ? 1 : 2; } catch (e) { r = 3; } out = out * 10 + r; }
class L extends Error {}
class P extends Promise {}
L.code = 7;
P.resolve = function () { return 42; };
t(function () { return id(L).code === 7 && L.code === 7; });
t(function () { id(L).code = 8; return L.code === 8; });
t(function () { return Reflect.get(P, "resolve")() === 42; });`);
    expect(out).toBe(111);
  });

  it("Promise.all.call(C, …) reads the user's module-scope `C.resolve` (D4 invoke-resolve-…-custom)", async () => {
    // The drive stops at the first element today (#5197 R3-7: a native `$Promise` has no readable
    // `then`), so only the dispatch to the user's resolve is pinned — never the reassigned intrinsic.
    const out = await runStandalone(`
class Custom extends Promise {}
var cres = 0;
var pres = 0;
var boundCustomResolve = Custom.resolve.bind(Custom);
var boundPromiseResolve = Promise.resolve.bind(Promise);
Custom.resolve = function (v) { cres += 1; return boundCustomResolve(v); };
Promise.resolve = function (v) { pres += 1; return boundPromiseResolve(v); };
Promise.all.call(Custom, [1, 1, 1]);
out = (cres > 0 ? 10 : 20) + (pres === 0 ? 1 : 2);`);
    expect(out).toBe(11);
  });

  it("control: typed access is unchanged — read, call, and a static member reading `this.p`", async () => {
    const out = await runStandalone(`${PRELUDE}
class S { static get sx() { return this._x; } static m() { return this.tag; } }
S._x = 3;
S.tag = "t";
t(function () { return K.bar === 5 && K.foo() === 42; });
t(function () { return S.sx === 3 && S.m() === "t"; });`);
    expect(out).toBe(11);
  });

  it("control: no module-scope class write, or the gc lane, emits none of the new arms", async () => {
    const noCells = await watOf(`class K {}\nfunction g() { K.bar = 5; return K.bar; }\nout = g();`, "standalone");
    expect(noCells).not.toContain("__cls_expando_recv");
    const gcLane = await watOf(`class K {}\nK.bar = 5;\nout = K.bar;`, undefined);
    expect(gcLane).not.toContain("__cls_expando_recv");
    const withCells = await watOf(`class K {}\nK.bar = 5;\nout = K.bar;`, "standalone");
    expect(withCells).toContain("__cls_expando_recv");
  });
});
