// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 cluster F, slice F3) The §10.5 proxy dispatch was reached by SPELLING,
 * not by value.
 *
 * `new Proxy(t, h)` written literally routed `Object.defineProperty(p, …)` and
 * `new p()` into the proxy dispatch. The SAME proxy reached through any other
 * spelling of the constructor — `var PP = Proxy; new PP(t, h)`, or the
 * cross-realm `var OProxy = $262.createRealm().global.Proxy; new OProxy(t, h)`
 * that every `built-ins/Proxy/**\/*-realm*` row uses — did not: the define trap
 * ran ZERO times and `new p()` ran no construct trap and threw nothing.
 *
 * The runtime was never the problem. Probed on base, the same proxies dispatch
 * correctly for `get` / `has` / `getOwnPropertyDescriptor`, through
 * `Reflect.defineProperty`, and through a helper (`function nn(x){return new
 * x();} nn(p)`) — which runs the trap AND throws the §10.5.14 step-11
 * TypeError. Only the two STATIC admissions declined, so the fix is to ask
 * `tracesToProxyConstructorValue` ("does this `new` make a proxy?") instead of
 * testing the identifier text.
 *
 * These pins use the ALIAS spelling rather than the realm one: it takes the
 * identical code path (an alias hop under the single-assignment proof) and
 * needs no `$262` host. All seven were run against this branch's base: three
 * are RED there (both `defineProperty` cases and the §10.5.14 step-11 throw)
 * and four are green on both sides. One of those four is worth naming — an
 * alias-built proxy DOES run its construct trap on base; what base loses is
 * the post-trap step-11 check, which is why the trap-ran pin passes while the
 * throw pin fails. It stays as a guard rather than being deleted: it is the
 * control that says the widening did not change the trap-invocation half.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/** Compile `body` as module-scope JavaScript; return the `__f3` bitmask. */
async function runModuleScopeJs(body: string): Promise<number> {
  const source = `var __f3 = 0;\n${body}\nexport function readResult() { return __f3; }\n`;
  const result = await compile(source, {
    target: "standalone",
    fileName: "issue-6651-f3.js",
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

describe("#6651 F3 — the defineProperty dispatch follows the value, not the spelling", () => {
  it("RED on base: an aliased-constructor proxy runs its defineProperty trap", async () => {
    expect(
      await runModuleScopeJs(`
      var PP = Proxy;
      var p = new PP({}, { defineProperty: function (t, k, d) { __f3 += 1; return true; } });
      Object.defineProperty(p, "x", { value: 1 });`),
    ).toBe(1);
  });

  it("RED on base: a non-callable defineProperty trap throws through the alias spelling", async () => {
    expect(
      await runModuleScopeJs(`
      var PP = Proxy;
      var p = new PP({}, { defineProperty: {} });
      try { Object.defineProperty(p, "x", { value: 1 }); } catch (e) { if (e instanceof TypeError) __f3 += 1; }`),
    ).toBe(1);
  });
});

describe("#6651 F3 — the construct dispatch follows the value, not the spelling", () => {
  it("GUARD (green on base too): an aliased-constructor proxy runs its construct trap", async () => {
    expect(
      await runModuleScopeJs(`
      var PP = Proxy;
      var p = new PP(function () {}, { construct: function (t, a, nt) { __f3 += 1; return {}; } });
      new p();`),
    ).toBe(1);
  });

  it("RED on base: §10.5.14 step 11 rejects a non-object trap result through the alias spelling", async () => {
    expect(
      await runModuleScopeJs(`
      var PP = Proxy;
      var p = new PP(function () {}, { construct: function () { return true; } });
      try { new p(); } catch (e) { if (e instanceof TypeError) __f3 += 1; }`),
    ).toBe(1);
  });
});

describe("#6651 F3 — guards (green on both sides)", () => {
  it("the literal new Proxy spelling still dispatches both operations", async () => {
    expect(
      await runModuleScopeJs(`
      var p = new Proxy({}, { defineProperty: function () { __f3 += 1; return true; } });
      Object.defineProperty(p, "x", { value: 1 });
      var q = new Proxy(function () {}, { construct: function () { __f3 += 2; return {}; } });
      new q();`),
    ).toBe(3);
  });

  it("an ordinary object receiver keeps the ordinary defineProperty store", async () => {
    expect(
      await runModuleScopeJs(`
      var o = {};
      Object.defineProperty(o, "x", { value: 7, enumerable: true });
      if (o.x === 7) __f3 += 1;
      var d = Object.getOwnPropertyDescriptor(o, "x");
      if (d && d.value === 7) __f3 += 2;`),
    ).toBe(3);
  });

  it("§19.1.2.4 step 1 still rejects a non-object receiver", async () => {
    expect(
      await runModuleScopeJs(`
      try { Object.defineProperty(null, "x", { value: 1 }); } catch (e) { if (e instanceof TypeError) __f3 += 1; }
      try { Object.defineProperty(1, "x", { value: 1 }); } catch (e) { if (e instanceof TypeError) __f3 += 2; }`),
    ).toBe(3);
  });
});
