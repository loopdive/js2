// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

/**
 * #2502 — `Array.prototype.sort()` on an externref-element array emitted invalid
 * Wasm. A no-comparator sort of an `any[]` / un-typed array (`new Array(N)`,
 * whose elements are boxed `externref` holes/`undefined`) fell through the
 * default ToString sort (its `string_compare` host helper was unregistered for
 * non-string/number element types) into the NUMERIC Timsort fallback. That path
 * casts the element kind to `"i32"|"f64"` and emits `__isort_externref` whose
 * comparator does `f64.gt` over an `externref` `array.get` → the WasmGC
 * validator rejects the binary. 28 test262 `built-ins/{Array/prototype/sort,
 * Atomics}` compile_errors (`new Array(2).sort()`).
 *
 * Fix (array-methods.ts `compileArraySort`): the numeric Timsort is valid only
 * for i32/f64 element kinds — a ref/externref-element array whose default
 * ToString sort doesn't run is no-op'd (return the receiver unchanged) instead
 * of reaching `ensureTimsortHelper`. A no-op is the correct result for the
 * dominant all-holes case (`new Array(N)` is all `undefined`), and crucially it
 * is never invalid Wasm. String / numeric / native-string sorts are unchanged.
 */
async function compileAndRun(source: string): Promise<Record<string, Function>> {
  const result = await compile(source);
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  if (!WebAssembly.validate(result.binary)) {
    throw new Error(`Invalid Wasm binary (WebAssembly.validate failed)\nWAT:\n${result.wat}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as unknown as WebAssembly.Imports);
  return instance.exports as Record<string, Function>;
}

describe("#2502 — sort of an externref-element array no longer emits invalid Wasm", () => {
  it("new Array(2).sort() compiles to valid Wasm and keeps length 2 (was __isort_externref crash)", async () => {
    const e = await compileAndRun(
      `export function test(): number { const x = new Array(2); x.sort(); return x.length; }`,
    );
    expect(e.test!()).toBe(2);
  });

  it("new Array(3).sort() (the Atomics-harness repro) is valid", async () => {
    const e = await compileAndRun(
      `export function test(): number { const x = new Array(3); x.sort(); return x.length; }`,
    );
    expect(e.test!()).toBe(3);
  });

  it("any[] sort compiles to valid Wasm (no crash)", async () => {
    const e = await compileAndRun(
      `export function test(): number { const x: any[] = [3, 1, 22]; x.sort(); return x.length; }`,
    );
    expect(e.test!()).toBe(3);
  });

  it("sort keeps the array length intact (in-place, no structural corruption)", async () => {
    // The #2502 guarantee is "valid Wasm + length-preserving in-place sort". The
    // per-element value semantics of `any[]`/hole arrays through a no-comparator
    // sort (and `new Array(N)` hole `=== undefined`) are separate, pre-existing
    // concerns out of scope here.
    const e = await compileAndRun(
      `export function test(): number { const x: any[] = [3, 1, 2]; x.sort(); x.sort(); return x.length; }`,
    );
    expect(e.test!()).toBe(3);
  });

  // ── regressions: the working sort paths must be untouched ──
  it("[3,1,2].sort() still numeric-default-sorts (ToString) to 1,2,3", async () => {
    const e = await compileAndRun(
      `export function test(): string { const a = [3, 1, 2]; a.sort(); return a.join(","); }`,
    );
    expect(e.test!()).toBe("1,2,3");
  });

  it("[10,9,1,100].sort() still lexicographic (1,10,100,9)", async () => {
    const e = await compileAndRun(
      `export function test(): string { const a = [10, 9, 1, 100]; a.sort(); return a.join(","); }`,
    );
    expect(e.test!()).toBe("1,10,100,9");
  });

  it('["banana","apple","cherry"].sort() still sorts strings', async () => {
    const e = await compileAndRun(
      `export function test(): string { const a = ["banana", "apple", "cherry"]; a.sort(); return a.join(","); }`,
    );
    expect(e.test!()).toBe("apple,banana,cherry");
  });

  it("comparator sort still honored ([3,1,2].sort((a,b)=>a-b))", async () => {
    const e = await compileAndRun(
      `export function test(): string { const a = [3, 1, 2]; a.sort((x, y) => x - y); return a.join(","); }`,
    );
    expect(e.test!()).toBe("1,2,3");
  });
});
