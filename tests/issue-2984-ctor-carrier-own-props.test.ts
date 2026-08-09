// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2984 slice "ctor-carrier own props" — the standalone reified builtin
// CONSTRUCTOR carrier (#3006 `emitBuiltinConstructorIdentity` / #2907
// `emitBuiltinNamespaceObject`) now owns its §17/§20 `length` / `name` /
// `prototype` data properties.
//
// WHY this matters (measured on main @ bb5b414a05b6d0, standalone lane):
// test262's `propertyHelper.js verifyProperty(obj, key, desc)` takes its
// receiver as an UNTYPED harness parameter, so every descriptor query it makes
// is a RUNTIME one. None of #2984's syntactic Phase-2/3 synthesis can fire
// there. Probing through a `function ho(a,b){return
// Object.prototype.hasOwnProperty.call(a,b);}` indirection showed native method
// closures answer correctly (#2896 `__builtinfn_*`) while builtin CTORS answer
// "absent" — their carrier was an EMPTY `$Object`. The `$Object` runtime
// already honours per-property attributes on every dynamic path, so seeding the
// three spec properties at materialization is all that was missing.
//
// The assertions below deliberately read `writable`/`enumerable`/
// `configurable`/`value` INDEPENDENTLY (and prefer NUMERIC and OBJECT-IDENTITY
// comparisons over string ones) rather than trusting a test262 verdict — a
// string `assert.sameValue` can false-positive on the standalone lane, so a
// string-only check would not be evidence the descriptor is right.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(body: string): Promise<number> {
  const src = `export function test(): number { ${body} }`;
  const r = await compile(src, { target: "standalone", skipSemanticDiagnostics: true });
  expect(r.success, r.errors?.map((e) => e.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): number }).test();
}

// Route the receiver through an `any`-typed parameter, exactly as
// `verifyProperty` does — this is the shape the whole slice is about.
const THRU_FN = `
  var hits = 0;
  var check = function (a: any, b: any): void { if (a === b) { hits = hits + 1; } };
  var gg = function (o: any, k: any): any { return Object.getOwnPropertyDescriptor(o, k); };
  var ho = function (o: any, k: any): any { return Object.prototype.hasOwnProperty.call(o, k); };
`;

describe("#2984 ctor-carrier own props: runtime descriptor MOP on builtin constructors", () => {
  it("WeakMap.name — runtime hasOwnProperty + full attribute triple (§20.2.4.2)", async () => {
    const ret = await runStandalone(`
      ${THRU_FN}
      check(ho(WeakMap, "name"), true);
      var d = gg(WeakMap, "name");
      check(typeof d, "object");
      check(d.writable, false);
      check(d.enumerable, false);
      check(d.configurable, true);
      return hits;
    `);
    expect(ret).toBe(5);
  });

  it("WeakMap.length — NUMERIC value 0 through the runtime descriptor (§20.2.4.1)", async () => {
    const ret = await runStandalone(`
      ${THRU_FN}
      check(ho(WeakMap, "length"), true);
      var d = gg(WeakMap, "length");
      check(d.value, 0);
      check(d.writable, false);
      check(d.enumerable, false);
      check(d.configurable, true);
      return hits;
    `);
    expect(ret).toBe(5);
  });

  it("RangeError.length — NUMERIC value 1 (Error-family namespace carrier)", async () => {
    const ret = await runStandalone(`
      ${THRU_FN}
      var d = gg(RangeError, "length");
      check(d.value, 1);
      check(d.configurable, true);
      check(d.writable, false);
      return hits;
    `);
    expect(ret).toBe(3);
  });

  it("Map.prototype — OBJECT IDENTITY with the syntactic read, all-false attributes", async () => {
    const ret = await runStandalone(`
      ${THRU_FN}
      check(ho(Map, "prototype"), true);
      var d = gg(Map, "prototype");
      check(d.value, Map.prototype);
      check(d.writable, false);
      check(d.enumerable, false);
      check(d.configurable, false);
      return hits;
    `);
    expect(ret).toBe(5);
  });

  it("distinct ctors carry distinct prototypes (not a null-null tautology)", async () => {
    const ret = await runStandalone(`
      ${THRU_FN}
      var a = gg(Map, "prototype");
      var b = gg(Set, "prototype");
      if (a.value !== b.value) { hits = hits + 1; }
      if (a.value === Map.prototype) { hits = hits + 1; }
      if (b.value === Set.prototype) { hits = hits + 1; }
      return hits;
    `);
    expect(ret).toBe(3);
  });

  it("the seeded properties are NON-ENUMERABLE (Object.keys / for-in unchanged)", async () => {
    const ret = await runStandalone(`
      var hits = 0;
      if (Object.keys(WeakMap).length === 0) { hits = hits + 1; }
      var n = 0;
      for (var k in WeakMap) { n = n + 1; }
      if (n === 0) { hits = hits + 1; }
      if (Object.keys(RangeError).length === 0) { hits = hits + 1; }
      return hits;
    `);
    expect(ret).toBe(3);
  });

  it("GUARD: true NAMESPACES (Math/JSON/Reflect) get no name/length/prototype", async () => {
    const ret = await runStandalone(`
      ${THRU_FN}
      check(ho(Math, "name"), false);
      check(ho(Math, "length"), false);
      check(ho(Math, "prototype"), false);
      check(ho(JSON, "name"), false);
      check(ho(Reflect, "name"), false);
      return hits;
    `);
    expect(ret).toBe(5);
  });

  it("GUARD: the syntactic folds and #3006 ctor identity are unchanged", async () => {
    const ret = await runStandalone(`
      ${THRU_FN}
      check(WeakMap.name, "WeakMap");
      check(WeakMap.length, 0);
      check(Map.prototype.constructor, Map);
      if (Set !== Map) { hits = hits + 1; }
      if (Set === Set) { hits = hits + 1; }
      return hits;
    `);
    expect(ret).toBe(5);
  });

  it("configurable:true seeded props delete; configurable:false ones survive", async () => {
    // `verifyProperty`'s `isConfigurable` does `delete obj[name]` inside a
    // TypeError-tolerant try/catch and then requires `hasOwnProperty` to agree.
    // Our runtime is over-strict for the non-configurable case (sloppy-mode
    // `delete` should return false rather than throw — a pre-existing
    // `$Object` behaviour, harness-tolerated), so the probe mirrors the
    // harness and catches. What must hold is the POST-STATE.
    const ret = await runStandalone(`
      ${THRU_FN}
      var del = function (o: any, k: any): number { try { delete o[k]; return 0; } catch (e) { return 1; } };
      del(WeakSet, "name");
      check(ho(WeakSet, "name"), false);
      del(WeakSet, "prototype");
      check(ho(WeakSet, "prototype"), true);
      return hits;
    `);
    expect(ret).toBe(2);
  });

  it("KNOWN GAP (pre-existing): a dynamic write bypasses the non-writable flag", async () => {
    // The DESCRIPTOR correctly reports `writable:false`, but the dynamic
    // `o[k] = v` store path (`__extern_set`) does not consult `$PropEntry`
    // flags, so the write lands. This is a pre-existing `$Object` runtime gap
    // (it reproduces for any `Object.defineProperty`-defined non-writable
    // property, not just these carriers) — pinned here so a future fix in the
    // store path is noticed rather than silently changing this slice's shape.
    const ret = await runStandalone(`
      ${THRU_FN}
      var wr = function (o: any, k: any, v: any): void { o[k] = v; };
      var rd = function (o: any, k: any): any { return o[k]; };
      check(gg(WeakRef, "length").writable, false);
      wr(WeakRef, "length", 99);
      check(rd(WeakRef, "length"), 99);
      return hits;
    `);
    expect(ret).toBe(2);
  });

  it("host (gc) lane still compiles the same sources", async () => {
    const src = `export function test(): number {
      var d: any = Object.getOwnPropertyDescriptor(WeakMap, "name");
      return d === undefined ? 0 : 1;
    }`;
    const r = await compile(src, { skipSemanticDiagnostics: true });
    expect(r.success, r.errors?.map((e) => e.message).join("\n")).toBe(true);
  });
});
