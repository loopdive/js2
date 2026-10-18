// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2984 Phase 3 — standalone `Object.getOwnPropertyDescriptor(<Ctor|Namespace>,
// "<member>")` static-property descriptor synthesis.
//
// On main, a builtin CONSTRUCTOR / namespace identifier used as a gOPD receiver
// routed through the `__get_builtin` shortcut, which refuses-loud under
// `--target standalone` — the whole shape hard-CE'd (72 files in the test262
// gOPD dirs). Every own property of a standard builtin ctor/namespace is
// statically known, so the descriptor is synthesized at compile time
// (src/codegen/builtin-static-gopd.ts):
//   - static METHODS ({w:true,e:false,c:true}) carry the per-(builtin, method)
//     SINGLETON closure — the same value a plain `Math.atan2` read yields, so
//     `desc.value === Math.atan2` (the dominant 15.2.3.3-4-* assertion);
//   - Math/Number constants, `<Ctor>.prototype`, `<Ctor>.length`/`.name`, and
//     `<TypedArray>.BYTES_PER_ELEMENT` fold to spec-attribute data descriptors;
//   - unknown string keys on CLOSED-universe receivers answer `undefined`
//     (`gOPD(Math, "caller")`); Symbol / RegExp (open universes: well-known
//     symbol props / annex-B legacy statics) keep the loud refusal.
// Companion change: `ensureStandaloneBuiltinStaticMethodClosure` reifies any
// `BUILTIN_STATIC_METHOD_ARITY` member with a catchable-TypeError body
// (the #2193/#2651/Phase-2 degrade-to-catchable pattern), so plain static
// value reads (`var f = Math.atan2`) stop CE-ing too.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(body: string): Promise<number> {
  const src = `export function test(): number { ${body} }`;
  const r = await compile(src, { target: "standalone", skipSemanticDiagnostics: true });
  expect(r.success, r.errors?.map((e) => e.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): number }).test();
}

async function compileStandalone(body: string): Promise<{ success: boolean; message: string }> {
  const src = `export function test(): number { ${body} }`;
  const r = await compile(src, { target: "standalone", skipSemanticDiagnostics: true });
  return { success: r.success, message: r.errors?.map((e) => e.message).join("\n") ?? "" };
}

describe("#2984 phase 3: gOPD static-method descriptors (ctor/namespace receiver)", () => {
  it("gOPD(Math, 'atan2') — value identity + spec attributes", async () => {
    const ret = await runStandalone(`
      var hits = 0;
      var check = function (a: any, b: any): void { if (a === b) { hits = hits + 1; } };
      var desc = Object.getOwnPropertyDescriptor(Math, "atan2");
      check(desc.value, Math.atan2);
      check(desc.writable, true);
      check(desc.enumerable, false);
      check(desc.configurable, true);
      return hits;
    `);
    expect(ret).toBe(4);
  });

  it("gOPD(JSON, 'stringify') — value identity with the wired closure", async () => {
    const ret = await runStandalone(`
      var hits = 0;
      var check = function (a: any, b: any): void { if (a === b) { hits = hits + 1; } };
      var desc = Object.getOwnPropertyDescriptor(JSON, "stringify");
      check(desc.value, JSON.stringify);
      check(desc.writable, true);
      return hits;
    `);
    expect(ret).toBe(2);
  });

  it("gOPD(Object, 'getPrototypeOf') / gOPD(String, 'fromCharCode') / gOPD(Date, 'UTC') identity", async () => {
    const ret = await runStandalone(`
      var hits = 0;
      var check = function (a: any, b: any): void { if (a === b) { hits = hits + 1; } };
      check(Object.getOwnPropertyDescriptor(Object, "getPrototypeOf").value, Object.getPrototypeOf);
      check(Object.getOwnPropertyDescriptor(String, "fromCharCode").value, String.fromCharCode);
      check(Object.getOwnPropertyDescriptor(Date, "UTC").value, Date.UTC);
      return hits;
    `);
    expect(ret).toBe(3);
  });

  it("static singletons: self-identity holds, distinct methods stay distinct", async () => {
    // NOTE: desc-vs-desc `.value` identity across two SEPARATE gOPD calls
    // (`gOPD(Math,"max").value === gOPD(Math,"max").value`) does NOT hold —
    // but that is a pre-existing $Object store/read round-trip quirk measured
    // identically on main for the Phase-2 proto members
    // (`gOPD(Date.prototype,"getTime")` desc-vs-desc is 0 there too), and the
    // test262 corpus only asserts desc-vs-plain-read. Out of scope here.
    const ret = await runStandalone(`
      var hits = 0;
      if (Math.max === Math.max) { hits = hits + 1; }
      if (Math.max !== Math.min) { hits = hits + 1; }
      var d: any = Object.getOwnPropertyDescriptor(Math, "max");
      var v: any = d.value;
      if (v === Math.max) { hits = hits + 1; }
      return hits;
    `);
    expect(ret).toBe(3);
  });
});

describe("#2984 phase 3: gOPD value-constant / prototype / length descriptors", () => {
  it("gOPD(Math, 'PI') — all-false attributes, no get/set, correct value", async () => {
    const ret = await runStandalone(`
      var hits = 0;
      var check = function (a: any, b: any): void { if (a === b) { hits = hits + 1; } };
      var desc = Object.getOwnPropertyDescriptor(Math, "PI");
      check(desc.writable, false);
      check(desc.enumerable, false);
      check(desc.configurable, false);
      check(desc.hasOwnProperty("get"), false);
      check(desc.hasOwnProperty("set"), false);
      check(desc.value, Math.PI);
      return hits;
    `);
    expect(ret).toBe(6);
  });

  it("gOPD(Number, 'MAX_VALUE') — all-false value constant", async () => {
    const ret = await runStandalone(`
      var hits = 0;
      var check = function (a: any, b: any): void { if (a === b) { hits = hits + 1; } };
      var desc = Object.getOwnPropertyDescriptor(Number, "MAX_VALUE");
      check(desc.writable, false);
      check(desc.configurable, false);
      check(desc.value, Number.MAX_VALUE);
      return hits;
    `);
    expect(ret).toBe(3);
  });

  it("gOPD(<Ctor>, 'prototype') — {w:false, e:false, c:false}, no get/set (Object/Date/Error)", async () => {
    const ret = await runStandalone(`
      var hits = 0;
      var check = function (a: any, b: any): void { if (a === b) { hits = hits + 1; } };
      var d1 = Object.getOwnPropertyDescriptor(Object, "prototype");
      check(d1.writable, false);
      check(d1.enumerable, false);
      check(d1.configurable, false);
      check(d1.hasOwnProperty("get"), false);
      check(d1.hasOwnProperty("set"), false);
      var d2 = Object.getOwnPropertyDescriptor(Date, "prototype");
      check(d2.writable, false);
      check(d2.configurable, false);
      var d3 = Object.getOwnPropertyDescriptor(Error, "prototype");
      check(d3.writable, false);
      check(d3.configurable, false);
      return hits;
    `);
    expect(ret).toBe(9);
  });

  it("gOPD(<Ctor>, 'length') — {w:false, e:false, c:true} with the spec arity", async () => {
    const ret = await runStandalone(`
      var hits = 0;
      var check = function (a: any, b: any): void { if (a === b) { hits = hits + 1; } };
      var desc = Object.getOwnPropertyDescriptor(Number, "length");
      check(desc.writable, false);
      check(desc.enumerable, false);
      check(desc.configurable, true);
      check(desc.value, 1);
      var d7 = Object.getOwnPropertyDescriptor(Date, "length");
      check(d7.value, 7);
      return hits;
    `);
    expect(ret).toBe(5);
  });
});

describe("#2984 phase 3: absent members and preserved refusals", () => {
  it("gOPD on a genuinely absent member answers undefined (Math.caller, Function.arguments_1)", async () => {
    const ret = await runStandalone(`
      var hits = 0;
      if (Object.getOwnPropertyDescriptor(Math, "caller") === undefined) { hits = hits + 1; }
      if (Object.getOwnPropertyDescriptor(Function, "arguments_1") === undefined) { hits = hits + 1; }
      if (Object.getOwnPropertyDescriptor(Math, "prototype") === undefined) { hits = hits + 1; }
      return hits;
    `);
    expect(ret).toBe(3);
  });

  it("GUARD: Symbol well-knowns answer a real descriptor, RegExp legacy statics keep the loud refusal (no phantom undefined)", async () => {
    // (#7014 wave 15) The Symbol half used to pin a compile refusal. Standalone
    // now answers gOPD(Symbol, "iterator") natively, and it is not a phantom
    // undefined: the descriptor exists, as in JS (re-measured 2026-10-17 on
    // upstream main 0727e2985b). The RegExp annex-B statics still refuse.
    expect(
      await runStandalone(`
      var d: any = Object.getOwnPropertyDescriptor(Symbol, "iterator");
      return d === undefined ? 1 : 0;
    `),
    ).toBe(0);
    const re = await compileStandalone(`
      var d: any = Object.getOwnPropertyDescriptor(RegExp, "$1");
      return d === undefined ? 1 : 0;
    `);
    expect(re.success).toBe(false);
    expect(re.message).toContain("__get_builtin");
  });

  it("plain static value reads stop CE-ing (first-class typeof function)", async () => {
    // NOTE: only the READ is asserted. Invoking the extracted value routes
    // through the direct-call-of-closure plumbing, which null-derefs on main
    // even for the wired `Object.keys` (`var f = Object.keys; f(o)` traps) —
    // a pre-existing gap outside this slice; the test262 corpus never invokes
    // the extracted static either.
    const ret = await runStandalone(`
      var f: any = Math.atan2;
      var g: any = Date.parse;
      var hits = 0;
      if (typeof f === "function") { hits = hits + 1; }
      if (typeof g === "function") { hits = hits + 1; }
      return hits;
    `);
    expect(ret).toBe(2);
  });
});
