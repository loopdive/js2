// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1816 — `Array.prototype.sort` must honor a user comparator.
 *
 * Residual of #1361: the sort path called `ensureTimsortHelper`, which hard-codes
 * numeric `i32.lt_s`/`f64.lt` and ignored any `comparefn`, so
 * `[3,1,2].sort((a,b)=>b-a)` returned `[1,2,3]`. The fix routes comparator sorts
 * through a stable insertion sort that invokes the comparator closure via
 * `call_ref` and uses the spec ordering `comparator(a,b) > 0 ⇒ a after b`
 * (§23.1.3.30 / SortIndexedProperties / CompareArrayElements).
 *
 * These tests assert the resulting *order* (the prior test only asserted
 * "doesn't throw", which masked the bug).
 *
 * #1816 residual (default-ToString half): with `comparefn` undefined,
 * SortCompare converts each element to a String and orders by UTF-16 code-unit
 * comparison, so `[10,2,1].sort()` is `[1,10,2]`, not the numeric `[1,2,10]`.
 * In native-strings mode (standalone/WASI) the default path now stringifies via
 * `number_toString` and compares via the native `__str_compare` helper.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runExport(source: string, fn: string): Promise<number> {
  const result = await compile(source, { fileName: "t.js", target: "wasi", nativeStrings: true });
  expect(result.success, `Compile failed: ${result.errors?.map((e) => e.message).join("; ")}`).toBe(true);
  // Provide a no-op stub for every host import (some array shapes pull one in).
  const imports: Record<string, Record<string, () => number>> = {
    wasi_snapshot_preview1: new Proxy({}, { get: () => () => 0 }) as Record<string, () => number>,
  };
  for (const imp of result.imports ?? []) {
    imports[imp.module] ??= {};
    imports[imp.module]![imp.name] = () => 0;
  }
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return (instance.exports[fn] as () => number)();
}

describe("#1816 — Array.prototype.sort honors the comparator", () => {
  it("descending comparator (b - a) reverses ascending input", async () => {
    // [3,1,2].sort((x,y)=>y-x) === [3,2,1] → packed 321
    expect(
      await runExport(
        `export function test(){ const a=[3,1,2]; a.sort((x,y)=>y-x); return a[0]*100+a[1]*10+a[2]; }`,
        "test",
      ),
    ).toBe(321);
  });

  it("ascending comparator (a - b) sorts ascending", async () => {
    expect(
      await runExport(
        `export function test(){ const a=[3,1,2]; a.sort((x,y)=>x-y); return a[0]*100+a[1]*10+a[2]; }`,
        "test",
      ),
    ).toBe(123);
  });

  it("descending comparator over a larger array", async () => {
    // [5,3,8,1,9,2,7] desc → [9,8,7,5,3,2,1]
    expect(
      await runExport(
        `export function test(){
           const a=[5,3,8,1,9,2,7]; a.sort((x,y)=>y-x);
           return (a[0]===9 && a[1]===8 && a[2]===7 && a[3]===5 && a[4]===3 && a[5]===2 && a[6]===1) ? 1 : 0;
         }`,
        "test",
      ),
    ).toBe(1);
  });

  it("f64 comparator sorts floats", async () => {
    expect(
      await runExport(
        `export function test(){
           const a=[3.5,1.5,2.5]; a.sort((x,y)=>y-x);
           return (a[0]>a[1] && a[1]>a[2]) ? 1 : 0;
         }`,
        "test",
      ),
    ).toBe(1);
  });

  it("named-function comparator is honored", async () => {
    expect(
      await runExport(
        `function cmp(x,y){ return y-x; }
         export function test(){ const a=[1,3,2]; a.sort(cmp); return a[0]*100+a[1]*10+a[2]; }`,
        "test",
      ),
    ).toBe(321);
  });

  it("sort is stable (equal comparator keys preserve input order)", async () => {
    // Sort 2-digit numbers by their tens digit; the ones digit preserves order.
    // [21,12,11,22] keyed by tens (2,1,1,2) → stable → [12,11,21,22].
    expect(
      await runExport(
        `export function test(){
           const a=[21,12,11,22];
           a.sort((x,y)=>(((x/10)|0)-((y/10)|0)));
           return a[0]*1000000 + a[1]*10000 + a[2]*100 + a[3];
         }`,
        "test",
      ),
    ).toBe(12_11_21_22);
  });

  it("sort returns the receiver array (in-place)", async () => {
    expect(
      await runExport(
        `export function test(){ const a=[3,1,2]; const b=a.sort((x,y)=>x-y); return (b===a) ? a[0] : -1; }`,
        "test",
      ),
    ).toBe(1);
  });

  it("single-element and equal-element arrays are unchanged", async () => {
    expect(await runExport(`export function test(){ const a=[7]; a.sort((x,y)=>x-y); return a[0]; }`, "test")).toBe(7);
    expect(
      await runExport(`export function test(){ const a=[5,5,5]; a.sort((x,y)=>x-y); return a[0]+a[1]+a[2]; }`, "test"),
    ).toBe(15);
  });

  it("default no-arg sort already-sorted-by-string input is a no-op", async () => {
    // "1" < "2" < "3" coincides with numeric order here, so [1,2,3] stays put.
    expect(
      await runExport(`export function test(){ const a=[1,2,3]; a.sort(); return a[0]*100+a[1]*10+a[2]; }`, "test"),
    ).toBe(123);
  });

  it("default no-arg sort uses ToString code-unit order, not numeric (#1816 residual)", async () => {
    // §23.1.3.30 SortCompare with comparefn undefined → ToString both operands,
    // compare in UTF-16 code-unit order. `[10,2,1].sort()` is `[1,10,2]`
    // ("1" < "10" < "2"), NOT the numeric `[1,2,10]`.
    expect(
      await runExport(`export function test(){ const a=[10,2,1]; a.sort(); return a[0]*10000+a[1]*100+a[2]; }`, "test"),
    ).toBe(1_10_02); // [1, 10, 2]
  });

  it("default sort orders by leading code unit, not magnitude", async () => {
    // strings: "1" < "100" < "11" < "2" < "20" < "3" → [1, 100, 11, 2, 20, 3].
    expect(
      await runExport(
        `export function test(){
           const a=[3,20,100,1,11,2]; a.sort();
           return (a[0]===1 && a[1]===100 && a[2]===11 && a[3]===2 && a[4]===20 && a[5]===3) ? 1 : 0;
         }`,
        "test",
      ),
    ).toBe(1);
  });

  it("default sort over negatives uses string order", async () => {
    // strings: "-1" < "-10" < "-2" → [-1, -10, -2]. a[0] === -1.
    expect(await runExport(`export function test(){ const a=[-1,-10,-2]; a.sort(); return a[0]; }`, "test")).toBe(-1);
  });

  it("default sort: single-element and empty arrays are unchanged", async () => {
    expect(await runExport(`export function test(){ const a=[42]; a.sort(); return a[0]; }`, "test")).toBe(42);
    // Empty: start from a 1-element array, pop, then sort — exercises the len<2
    // early path without needing a type annotation (the harness compiles as .js).
    expect(await runExport(`export function test(){ const a=[7]; a.pop(); a.sort(); return a.length; }`, "test")).toBe(
      0,
    );
  });
});
