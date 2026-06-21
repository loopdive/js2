// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2379 — standalone: `Array.prototype.sort()` (no comparator) on an array whose
// element type is a boxed-any `externref` (a top-level `new Array(N)`, or an
// `any[]`) emitted INVALID Wasm in NATIVE-string mode (`--target standalone`).
//
// The default ToString sort (`compileArrayDefaultToStringSort`,
// src/codegen/array-methods.ts) routes ref/externref element kinds through its
// string branch, which in native mode `ref.cast`s each `array.get` element to
// `$AnyString`. That cast is valid only for a NativeString element ref — a raw
// `externref` (boxed-any) element is in a different reference-type hierarchy, so
// the validator rejected the binary:
//   "Invalid types for ref.cast: ref.as_non_null of (ref extern) has to be in
//    the same reference type hierarchy as (ref N)"  (in __module_init).
//
// #2502 had gated the NUMERIC Timsort fallback against externref elements, but
// the default-ToString-sort string branch ran *before* that gate and minted the
// invalid cast directly. The fix bails that branch for a native-mode externref
// element so the caller no-ops the sort (correct for the all-holes `new Array(N)`
// case) — never invalid Wasm. HOST mode is unaffected (its string branch emits
// no cast). The separate standalone `.join()` arity defect is tracked elsewhere.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function compileStandalone(source: string) {
  return compile(source, { target: "standalone" } as Parameters<typeof compile>[1]);
}

function valid(binary: Uint8Array | undefined): boolean {
  return binary ? WebAssembly.validate(binary) : false;
}

describe("#2379 standalone sort of an externref-element array emits valid Wasm", () => {
  it("top-level new Array(2).sort() compiles to valid standalone Wasm (was invalid ref.cast)", async () => {
    const r = await compileStandalone(`new Array(2).sort();`);
    expect(r.success).toBe(true);
    expect(valid(r.binary)).toBe(true);
  });

  it("new Array(3) with numeric writes + sort is valid standalone", async () => {
    const r = await compileStandalone(`const a = new Array(3); a[0] = 3; a[1] = 1; a[2] = 2; a.sort();`);
    expect(r.success).toBe(true);
    expect(valid(r.binary)).toBe(true);
  });

  it("any[] literal sort is valid standalone (boxed-any element rep)", async () => {
    const r = await compileStandalone(`const a: any[] = [3, 1, 22]; a.sort();`);
    expect(r.success).toBe(true);
    expect(valid(r.binary)).toBe(true);
  });

  // ── regressions: the typed/string element sorts must stay valid standalone ──
  it("number[] literal sort stays valid standalone (numeric ToString path)", async () => {
    const r = await compileStandalone(`const a = [3, 1, 2]; a.sort();`);
    expect(r.success).toBe(true);
    expect(valid(r.binary)).toBe(true);
  });

  it("string[] literal sort stays valid standalone (NativeString $AnyString cast)", async () => {
    const r = await compileStandalone(`const a = ["banana", "apple", "cherry"]; a.sort();`);
    expect(r.success).toBe(true);
    expect(valid(r.binary)).toBe(true);
  });

  it("comparator sort stays valid standalone", async () => {
    const r = await compileStandalone(`const a = [3, 1, 2]; a.sort((x, y) => x - y);`);
    expect(r.success).toBe(true);
    expect(valid(r.binary)).toBe(true);
  });
});
