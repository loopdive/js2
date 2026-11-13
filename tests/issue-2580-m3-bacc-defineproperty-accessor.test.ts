// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2580 M3 B-acc — `Object.defineProperty(arrayLike, "<idx>", {get/set})` accessor
// element retrieval in the generic `Array.prototype.X.call(arrayLike, cb)` cluster
// (host/gc mode; the dominant 181-file `-c-i-`/`-b-i-` lever).
//
// Root cause (verified per-process + binaryen-decoded WAT):
//   1. `Object.defineProperty(obj, "1", {set})` on a statically struct-typed
//      array-like (`var obj = {length:2}`) was captured into the COMPILED
//      `${structName}_1` accessor fast path (`compileObjectDefineProperty`, the
//      #1629-S3 `classAccessorSet` branch). That fast path is reachable ONLY from
//      the NAMED read site; an INDEXED element retrieval (`forEach.call(obj, cb)`)
//      reads via `__extern_get_idx` / `__extern_has_idx`, which consult the runtime
//      SIDECAR (`_wasmStructProps`), never `classAccessorSet`. For a canonical
//      array-index key that isn't an own struct field, the compiled accessor is
//      unreachable from BOTH read paths → the descriptor was silently dropped → the
//      generic-method loop never visited the index. Fix: decline the compiled
//      branch for a canonical-array-index accessor key so it routes to
//      `__defineProperty_accessor` (the sidecar the indexed-read path consults).
//   2. `__extern_has_idx` reported HasProperty=false for a setter-only accessor
//      (its `_sidecarGet` value is undefined), so even once stored the loop skipped
//      the index. Fix: treat an `__get_<idx>` / `__set_<idx>` sidecar entry as
//      HasProperty=true (§7.3.12 — presence is independent of value).
//   3. `__extern_get_idx` must INVOKE a defined getter (§6.2.5.5 Get) and return
//      undefined for a setter-only accessor (a *present* element holding undefined).
//
// SCOPE: this slice fixes OWN canonical-array-index accessors on a struct-typed
// array-like — the c-i / setter-only-and-getter subset. Inherited accessors on the
// built-in `Array.prototype` / `Object.prototype` data inheritance, and
// getter-bodies that close over outer scope, are separate sub-mechanisms (later
// slices). Host/gc only — standalone is blocked by the B-pre `__make_callback`
// host-import leak (separate issue), so these are host-mode tests.

import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runHost(source: string): Promise<unknown> {
  const result = await compile(source);
  if (!result.success) throw new Error("compile error: " + result.errors.map((e) => e.message).join("; "));
  if (!WebAssembly.validate(result.binary)) throw new Error("invalid wasm");
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  // (#7014) setInstance: raw setExports(instance.exports) lost data-struct authority in 708ebbd56d (#5337).
  (imports as { setInstance?: (e: WebAssembly.Instance) => void }).setInstance?.(instance);
  return (instance.exports as { run: () => unknown }).run();
}

describe("#2580 B-acc — defineProperty accessor element visit (host)", () => {
  // The canonical c-i-17 shape: setter-only accessor must be VISITED with
  // val === undefined (the accessor is present, Get yields undefined).
  it("forEach visits a setter-only accessor index with undefined", async () => {
    const src = `export function run(): string {
      let log = "";
      function cb(val: any, idx: any, _obj: any): void { log = log + idx + "=" + (typeof val) + ";"; }
      const obj: any = { length: 2 };
      Object.defineProperty(obj, "1", { set: function (_v: any): void {}, configurable: true });
      Array.prototype.forEach.call(obj, cb);
      return log;
    }`;
    expect(await runHost(src)).toBe("1=undefined;");
  });

  // A getter accessor index must be visited AND its getter invoked.
  it("forEach invokes a getter accessor index", async () => {
    const src = `export function run(): string {
      let log = "";
      function cb(val: any, idx: any, _obj: any): void { log = log + idx + "=" + val + ";"; }
      const obj: any = { length: 2 };
      Object.defineProperty(obj, "1", { get: function (): number { return 99; }, configurable: true });
      Array.prototype.forEach.call(obj, cb);
      return log;
    }`;
    expect(await runHost(src)).toBe("1=99;");
  });

  // some() over a getter accessor — the truthy getter value flips the result.
  // (`some` returns a boolean; this compiler surfaces it as the i32 1.)
  it("some honours a getter accessor element", async () => {
    const src = `export function run(): boolean {
      const obj: any = { length: 3 };
      Object.defineProperty(obj, "2", { get: function (): boolean { return true; }, configurable: true });
      return Array.prototype.some.call(obj, function (v: any): boolean { return v === true; });
    }`;
    expect(await runHost(src)).toBeTruthy();
  });

  // map() builds a result that includes the accessor element's getter value.
  it("map reads a getter accessor element", async () => {
    const src = `export function run(): number {
      const obj: any = { length: 2 };
      Object.defineProperty(obj, "0", { get: function (): number { return 5; }, configurable: true });
      Object.defineProperty(obj, "1", { get: function (): number { return 6; }, configurable: true });
      const r: any = Array.prototype.map.call(obj, function (v: any): number { return v + 1; });
      return r[0] + r[1];
    }`;
    expect(await runHost(src)).toBe(13);
  });

  // HasProperty via the `in` operator on an accessor index (the same sidecar
  // presence the indexed loop reads). (`in` surfaces as the i32 1 here.)
  it("`in` reports a setter-only accessor index present", async () => {
    const src = `export function run(): boolean {
      const obj: any = { length: 2 };
      Object.defineProperty(obj, "1", { set: function (_v: any): void {}, configurable: true });
      return (1 in obj);
    }`;
    expect(await runHost(src)).toBeTruthy();
  });

  // ── Regression guards: shapes that already worked must stay identical ──

  // A plain DATA element (no accessor) on an array-like — unchanged.
  it("forEach over plain data array-like is unchanged", async () => {
    const src = `export function run(): number {
      let sum = 0;
      const obj: any = { length: 3, 0: 10, 1: 20, 2: 30 };
      Array.prototype.forEach.call(obj, function (v: any): void { sum = sum + v; });
      return sum;
    }`;
    expect(await runHost(src)).toBe(60);
  });

  // A NAMED accessor (non-index key) must still resolve via the compiled
  // fast path — the decline gate is canonical-array-index ONLY.
  it("named accessor on a typed object still reads via the named path", async () => {
    const src = `export function run(): number {
      const obj: any = { x: 1 };
      Object.defineProperty(obj, "computed", { get: function (): number { return 42; }, configurable: true });
      return obj.computed;
    }`;
    expect(await runHost(src)).toBe(42);
  });

  // A real array's element reads are byte-identical (the hot path must not
  // enter the accessor sidecar arm).
  it("real array forEach unaffected", async () => {
    const src = `export function run(): number {
      let sum = 0;
      const a: number[] = [1, 2, 3, 4];
      a.forEach(function (v: number): void { sum = sum + v; });
      return sum;
    }`;
    expect(await runHost(src)).toBe(10);
  });

  // A typed array-like with an own data property AND a sibling accessor:
  // both must be visited (data via field, accessor via sidecar).
  it("mixed data + accessor array-like visits both", async () => {
    const src = `export function run(): string {
      let log = "";
      const obj: any = { length: 2, 0: 7 };
      Object.defineProperty(obj, "1", { get: function (): number { return 8; }, configurable: true });
      Array.prototype.forEach.call(obj, function (v: any, i: any): void { log = log + i + ":" + v + ";"; });
      return log;
    }`;
    expect(await runHost(src)).toBe("0:7;1:8;");
  });
});
