import { describe, it, expect } from "vitest";
import { compile, buildImports, instantiateWasm } from "../src/index.js";
import { compileAndRunHost as compileAndRun } from "./helpers/compile.js";

/**
 * #3902 — `Array.prototype.sort` lowering.
 *
 * Two independent defects, both surfaced by the published `array/sort-i32`
 * benchmark (774 ms for 10,000 elements, 1,586× the JS baseline, with no
 * gc-native bar at all):
 *
 *  1. BOTH sort lowerings (default ToString sort and comparator sort) emitted an
 *     in-place INSERTION sort — O(n²) comparisons, where every comparison is a
 *     `call_ref` into a user closure or a `number_toString` + `string_compare`
 *     host-import pair. Replaced by a shared stable bottom-up MERGE sort. These
 *     tests pin the observable contract that must survive the swap: total order,
 *     stability, in-placeness, and the run-boundary edge cases a merge sort has
 *     but an insertion sort does not (odd lengths, non-power-of-two lengths,
 *     the odd-pass-count copy-back).
 *
 *  2. In `nativeStrings` mode WITHOUT wasi/standalone — i.e. `fast: true`, the
 *     whole `gc-native` lane — `number_toString` resolves to the JS-HOST import
 *     while `string_compare` is skipped in favour of the native
 *     `__str_compare`. The default sort then `ref.cast` a genuine JS string to
 *     `$AnyString` and TRAPPED with `illegal cast`, which the benchmark harness
 *     swallowed into a missing bar.
 */

async function runFast(source: string): Promise<Record<string, Function>> {
  const result = await compile(source, { fast: true });
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const imports = buildImports(result.imports, {}, result.stringPool);
  const { instance } = await instantiateWasm(result.binary, imports.env, imports.string_constants);
  imports.setInstance?.(instance);
  return instance.exports as Record<string, Function>;
}

describe("#3902 — comparator sort keeps its total order under merge sort", () => {
  it("ascending numeric comparator", async () => {
    const e = await compileAndRun(
      `export function test(): string { const a = [10,9,1,100,2,25]; a.sort((x,y)=>x-y); return a.join(","); }`,
    );
    expect(e.test!()).toBe("1,2,9,10,25,100");
  });

  it("descending numeric comparator with duplicates", async () => {
    const e = await compileAndRun(
      `export function test(): string { const a = [3,1,4,1,5,9,2,6,5,3,5]; a.sort((x,y)=>y-x); return a.join(","); }`,
    );
    expect(e.test!()).toBe("9,6,5,5,5,4,3,3,2,1,1");
  });

  it("is stable — equal keys keep their input order", async () => {
    // Keys are the last digit; 21/11/31 all have key 1 and must stay in input
    // order, as must 32/12/22 with key 2. An unstable sort scrambles these.
    const e = await compileAndRun(
      `export function test(): string { const a = [21,11,32,12,31,22]; a.sort((x,y)=>(x%10)-(y%10)); return a.join(","); }`,
    );
    expect(e.test!()).toBe("21,11,31,32,12,22");
  });

  it("string comparator", async () => {
    const e = await compileAndRun(
      `export function test(): string { const a = ["bb","a","cccc","ddd"]; a.sort((x,y)=>x.length-y.length); return a.join(","); }`,
    );
    expect(e.test!()).toBe("a,bb,ddd,cccc");
  });

  it("sorts in place — the returned ref aliases the receiver", async () => {
    const e = await compileAndRun(
      `export function test(): string { const a = [3,1,2]; const out = a.sort((x,y)=>x-y); out.push(9); return a.join(","); }`,
    );
    expect(e.test!()).toBe("1,2,3,9");
  });

  it("length 0/1/2/3 — the merge sort's early-out and first pass", async () => {
    const empty = await compileAndRun(
      `export function test(): number { const a: number[] = []; a.sort((x,y)=>x-y); return a.length; }`,
    );
    expect(empty.test!()).toBe(0);
    const one = await compileAndRun(
      `export function test(): string { const a = [7]; a.sort((x,y)=>x-y); return a.join(","); }`,
    );
    expect(one.test!()).toBe("7");
    const two = await compileAndRun(
      `export function test(): string { const a = [2,1]; a.sort((x,y)=>x-y); return a.join(","); }`,
    );
    expect(two.test!()).toBe("1,2");
    const three = await compileAndRun(
      `export function test(): string { const a = [2,3,1]; a.sort((x,y)=>x-y); return a.join(","); }`,
    );
    expect(three.test!()).toBe("1,2,3");
  });

  it("non-power-of-two length exercises the ragged final run", async () => {
    // 37 elements: the last run of several passes is shorter than `width`, and
    // the pass count is odd, so this also covers the copy-back branch.
    const e = await compileAndRun(
      `export function test(): number {
         const a: number[] = [];
         for (let i = 0; i < 37; i = i + 1) a.push((i * 13 + 5) % 37);
         a.sort((x, y) => x - y);
         let bad = 0;
         for (let i = 0; i < 37; i = i + 1) if (a[i] !== i) bad = bad + 1;
         return bad;
       }`,
    );
    expect(e.test!()).toBe(0);
  });

  it("already-sorted and all-equal inputs are untouched", async () => {
    const sorted = await compileAndRun(
      `export function test(): string { const a = [1,2,3,4,5,6,7,8]; a.sort((x,y)=>x-y); return a.join(","); }`,
    );
    expect(sorted.test!()).toBe("1,2,3,4,5,6,7,8");
    const equal = await compileAndRun(
      `export function test(): string { const a = [5,5,5,5,5]; a.sort((x,y)=>x-y); return a.join(","); }`,
    );
    expect(equal.test!()).toBe("5,5,5,5,5");
  });

  it("1,000 elements in pseudo-random order sort correctly", async () => {
    const e = await compileAndRun(
      `export function test(): number {
         const a: number[] = [];
         for (let i = 0; i < 1000; i = i + 1) a.push((i * 37 + 13) % 1000);
         a.sort((x, y) => x - y);
         let bad = 0;
         for (let i = 0; i < 1000; i = i + 1) if (a[i] !== i) bad = bad + 1;
         return bad;
       }`,
    );
    expect(e.test!()).toBe(0);
  });
});

describe("#3902 — default (ToString) sort keeps §23.1.3.30 order under merge sort", () => {
  it("[10,9,1,100].sort() === [1,10,100,9]", async () => {
    const e = await compileAndRun(
      `export function test(): string { const a = [10,9,1,100]; a.sort(); return a.join(","); }`,
    );
    expect(e.test!()).toBe("1,10,100,9");
  });

  it("negatives keep lexicographic order", async () => {
    const e = await compileAndRun(
      `export function test(): string { const a = [3,-1,-20,11,0]; a.sort(); return a.join(","); }`,
    );
    expect(e.test!()).toBe("-1,-20,0,11,3");
  });

  it("string arrays sort lexicographically and stably", async () => {
    const e = await compileAndRun(
      `export function test(): string { const a = ["pear","apple","banana","apple"]; a.sort(); return a.join(","); }`,
    );
    expect(e.test!()).toBe("apple,apple,banana,pear");
  });
});

describe("#3902 — gc-native (fast) lane: default numeric sort no longer traps", () => {
  it("`arr.sort()` on a number[] runs instead of throwing `illegal cast`", async () => {
    // Regression guard for the number_toString-is-a-host-import mismatch. The
    // assertion deliberately avoids returning a string so the check is about the
    // sort, not about fast-mode string marshalling.
    const e = await runFast(
      `export function run(): number {
         const arr: number[] = [10, 9, 1, 100, 2, 25];
         arr.sort();
         const want: number[] = [1, 10, 100, 2, 25, 9];
         let bad = 0;
         for (let i = 0; i < 6; i = i + 1) if (arr[i] !== want[i]) bad = bad + 1;
         return bad;
       }`,
    );
    expect(e.run!()).toBe(0);
  });

  it("gc-native comparator sort over 5,000 elements is correct", async () => {
    const e = await runFast(
      `export function run(): number {
         const arr: number[] = [];
         for (let i = 0; i < 5000; i = i + 1) arr.push((i * 37 + 13) % 5000);
         arr.sort((a: number, b: number): number => a - b);
         let bad = 0;
         for (let i = 0; i < 5000; i = i + 1) if (arr[i] !== i) bad = bad + 1;
         return bad;
       }`,
    );
    expect(e.run!()).toBe(0);
  });
});
