// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// (#3200 slice 1) Array-like `.call(obj)` generic loops over fnctor-proto
// receivers: `__extern_get_idx` / `__extern_has_idx` must not trust a raw
// `__sget_<k>` probe. The getter is a ref.test shape-dispatch chain that
// NEVER traps — it answers null (or a zero-initialized slot on a
// structurally-colliding shape) for a receiver whose own shape lacks the
// field. The old arms returned that probe result as a real element / `return
// 1`-ed HasProperty for EVERY struct, masking inherited indices (fnctor
// prototype chain, §7.3.2 Get / §7.3.12 HasProperty are prototype-inclusive)
// and visiting holes as own. Both arms are now gated on `_readOwnDescriptor`
// (the #1589A field-name-registry discipline).
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function compileAndRun(source: string): Promise<unknown> {
  const r = await compile(source, { fileName: "test.ts" });
  expect(r.success, r.errors?.[0]?.message).toBe(true);
  const imports = buildImports(r.imports, undefined, r.stringPool) as unknown as WebAssembly.Imports & {
    setExports?: (e: Record<string, Function>) => void;
  };
  const { instance } = await WebAssembly.instantiate(r.binary!, imports);
  imports.setExports?.(instance.exports as Record<string, Function>);
  return (instance.exports as { test: () => unknown }).test();
}

describe("#3200 slice 1: array-like generic loop index MOP over fnctor proto chains", () => {
  it("own sidecar element overriding an inherited proto element is read (map)", async () => {
    const out = await compileAndRun(`
export function test(): any {
  function callbackfn(val: any, idx: any, obj: any) { return idx === 5 ? (val === "abc") : false; }
  var proto: any = { 5: 12 };
  var Con: any = function() {};
  Con.prototype = proto;
  var child: any = new Con();
  child[5] = "abc";
  child.length = 10;
  var r: any = Array.prototype.map.call(child, callbackfn);
  return (r[5] === true ? 1 : 0) + (r.length === 10 ? 2 : 0);
}`);
    expect(out).toBe(3);
  });

  it("inherited-only element is visited with its proto value (forEach)", async () => {
    const out = await compileAndRun(`
export function test(): any {
  var visited: any = 0;
  function callbackfn(val: any, idx: any, obj: any) { if (idx === 3 && val === 7) visited = visited + 1; return false; }
  var proto: any = { 3: 7 };
  var Con: any = function() {};
  Con.prototype = proto;
  var child: any = new Con();
  child.length = 5;
  Array.prototype.forEach.call(child, callbackfn);
  return visited;
}`);
    expect(out).toBe(1);
  });

  it("holes are NOT visited when an unrelated shape exports the index getter (forEach)", async () => {
    // GUARD: before the fix, __extern_has_idx `return 1`-ed for EVERY struct
    // whenever ANY shape in the module carried the field ("5" here, via the
    // unrelated literal) — visiting pure holes.
    const out = await compileAndRun(`
export function test(): any {
  var cnt: any = 0;
  function callbackfn(val: any, idx: any, obj: any) { cnt = cnt + 1; return false; }
  var unrelated: any = { 5: 1 };
  var Con: any = function() {};
  var child: any = new Con();
  child.length = 8;
  Array.prototype.forEach.call(child, callbackfn);
  return cnt + (unrelated[5] - 1);
}`);
    expect(out).toBe(0);
  });

  it("GUARD: own struct-field elements of an object-literal array-like still iterate (filter)", async () => {
    const out = await compileAndRun(`
export function test(): any {
  function callbackfn(val: any, idx: any, obj: any) { return val > 10; }
  var obj: any = { 0: 12, 1: 9, 2: 11, length: 3 };
  var r: any = Array.prototype.filter.call(obj, callbackfn);
  return r.length;
}`);
    expect(out).toBe(2);
  });
});

// (#3200 flatMap slice) §23.1.3.11 step 3 — IsCallable(mapperFunction) is false
// → throw TypeError BEFORE any flatten work. flatMap did not run the shared
// `emitCallbackTypeCheck` gate (map/filter/forEach do), so a missing or
// non-callable mapper silently fell through to the host `__array_flatMap`
// bridge, which wrapped the value in an always-callable arrow — hiding the
// non-callable from native flatMap's IsCallable check → no throw
// (built-ins/Array/prototype/flatMap/non-callable-argument-throws.js). The
// `Symbol()` arm additionally needs `ts.TypeFlags.ESSymbolLike` in
// `isKnownNonCallable`'s NON_CALLABLE_FLAGS (a symbol is never callable).
//
// Uses `skipSemanticDiagnostics` to mirror the test262 runner (raw JS: a
// non-function passed to `.flatMap` is a TS assignability error the runner
// suppresses, then compiles + runs).
async function compileAndRunLoose(source: string): Promise<unknown> {
  const r = await compile(source, {
    fileName: "test.ts",
    allowJs: true,
    skipSemanticDiagnostics: true,
  });
  expect(r.success, r.errors?.[0]?.message).toBe(true);
  const imports = buildImports(r.imports, undefined, r.stringPool) as unknown as WebAssembly.Imports & {
    setExports?: (e: Record<string, Function>) => void;
  };
  const { instance } = await WebAssembly.instantiate(r.binary!, imports);
  imports.setExports?.(instance.exports as Record<string, Function>);
  return (instance.exports as { test: () => unknown }).test();
}

describe("#3200 flatMap slice: non-callable mapper → TypeError (§23.1.3.11 step 3)", () => {
  it("throws TypeError for every non-callable mapper form", async () => {
    // Mirrors non-callable-argument-throws.js: object, number, implicit-undefined
    // (no arg), explicit undefined, null, boolean, string, symbol.
    const out = await compileAndRunLoose(`
export function test(): number {
  let thrown = 0;
  const s = Symbol();
  const cases: any[] = [
    () => [].flatMap({}),
    () => [].flatMap(0),
    () => [].flatMap(),
    () => [].flatMap(undefined),
    () => [].flatMap(null),
    () => [].flatMap(false),
    () => [].flatMap(''),
    () => [].flatMap(s),
  ];
  for (const c of cases) {
    try { c(); } catch (e) { if (e instanceof TypeError) thrown++; }
  }
  return thrown;
}`);
    expect(out).toBe(8);
  });

  it("GUARD: a valid array-returning mapper still flattens one level", async () => {
    const out = await compileAndRunLoose(`
export function test(): number {
  const r = [1, 2].flatMap((e: number) => [e, e * 2]);
  // [1,2,2,4]
  return r.length * 100 + r[0] * 10 + r[3];
}`);
    // length 4, r[0]=1, r[3]=4
    expect(out).toBe(414);
  });

  it("ESSymbolLike: map / filter / forEach also throw TypeError for a symbol callback", async () => {
    const out = await compileAndRunLoose(`
export function test(): number {
  let thrown = 0;
  const s = Symbol();
  const cases: any[] = [
    () => [1].map(s),
    () => [1].filter(s),
    () => [1].forEach(s),
  ];
  for (const c of cases) {
    try { c(); } catch (e) { if (e instanceof TypeError) thrown++; }
  }
  return thrown;
}`);
    expect(out).toBe(3);
  });
});
