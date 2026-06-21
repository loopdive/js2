// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2190 — standalone array element indexing through the externref boundary.
//
// Sibling of #2189 (array `.length` through the boundary). A real array literal
// lowers to a `__vec_<elemKind>` struct `(length i32, data (ref array))`. When
// such a value is boxed to externref (assigned to an `any` local, returned from
// an `any`-typed function), a NUMERIC indexed read `arr[i]` routes through the
// native `__extern_get_idx(externref, f64) -> externref` runtime helper. Before
// this fix that helper only recognised a `$ObjVec` (enumeration result) or an
// array-like `$Object` — NOT the concrete `__vec_<elemKind>` struct — so a boxed
// array fell through to null: `const a: any = [1,2,3]; a[1]` was 0 (null→f64) and
// `const a: any = ["x","y"]; a[1]` was null.
//
// Fix: `fillExternGetIdxVecArms` appends one `ref.test`/`ref.cast` arm per
// registered `__vec_<elemKind>` carrier at FINALIZE (after all carriers are
// known), bounds-checks against field 0 (length), reads `data[i]`, and boxes the
// element to externref per element kind (f64→__box_number, i32→convert+box,
// ref→extern.convert_any). Standalone only; host mode's `__extern_get_idx` import
// owns the path.
//
// (#88, #2190 GC-ref read-back) The STRING GC-ref element kind
// (`$AnyString`/`$NativeString`) is now boxed via `extern.convert_any` in
// `boxVecElementToExternref` — so a homogeneous-string sub-array of an `any[]`
// (`[["a","b"]]`) reads back through `e[0][0]` instead of trapping
// "dereferencing a null pointer". Non-string GC-ref / boolean carriers stay
// skipped (the per-carrier validity hazard the first cut hit is unchanged for
// them).
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<unknown> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary), "module failed WebAssembly.validate").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => unknown }).test();
}

describe("#2190 standalone array element indexing through the externref boundary", () => {
  it("number array index through `any` boundary returns the element", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const a: any = [10, 20, 30];
        return a[1];
      }`),
    ).toBe(20);
  });

  // (#2190 GC-ref read-back, #88) String (and other STRING GC-ref) array element
  // indexing through the externref boundary IS now resolved. The first cut of
  // #2190 deferred it because a naive typed-vec arm left a raw `(ref null N)` on
  // the `externref` return — invalid Wasm that regressed ~90 standalone tests.
  // `boxVecElementToExternref` now boxes a `$AnyString`/`$NativeString` element
  // via `extern.convert_any` (the universal GC-ref → externref conversion), so
  // the return is a genuine externref and the consuming site re-tests/casts it
  // back to `$AnyString`. A boxed string array therefore reads back its element
  // — `a[2]` is `"z"` (length 1), not `undefined`. Non-string GC-ref / boolean
  // carriers stay deferred (skipped → null) so the validity hazard is unchanged
  // for them.
  it("string array index through `any` boundary reads back the element (#88 GC-ref read-back)", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const a: any = ["x", "y", "z"];
        return (a[2] as string).length;
      }`),
    ).toBe(1);
  });

  it("index through an `any`-typed function return", async () => {
    expect(
      await runStandalone(`function g(): any { return [1, 2, 3, 4]; }
      export function test(): number {
        return g()[3];
      }`),
    ).toBe(4);
  });

  it("first element (index 0)", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const a: any = [42, 7];
        return a[0];
      }`),
    ).toBe(42);
  });

  it("out-of-bounds index yields undefined", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const a: any = [1, 2, 3];
        return a[99] === undefined ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("negative index yields undefined", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const a: any = [1, 2, 3];
        return a[-1] === undefined ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("length (#2189) and indexing (#2190) agree through the boundary", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const a: any = [5, 6, 7, 8];
        let sum = 0;
        for (let i = 0; i < a.length; i++) { sum += a[i]; }
        return sum;
      }`),
    ).toBe(26);
  });

  // (#88) homogeneous string sub-array nested read-back: `e[0]` is a boxed
  // `$AnyString[]` inner vec, `e[0][0]` indexes back through the boundary onto a
  // string GC-ref element. Pre-#88 this trapped on the inner index (the read-back
  // arm was missing for the string element kind).
  describe("#88 homogeneous string sub-array nested read-back", () => {
    it('e[0][0].length on [["a","b"]]', async () => {
      expect(
        await runStandalone(`export function test(): number {
          const e: any[] = [["a", "b"]];
          return (e[0][0] as string).length;
        }`),
      ).toBe(1);
    });

    it("e[0][1].length reads the second inner element", async () => {
      expect(
        await runStandalone(`export function test(): number {
          const e: any[] = [["a", "bb"]];
          return (e[0][1] as string).length;
        }`),
      ).toBe(2);
    });

    it("multi-row homogeneous string matrix", async () => {
      expect(
        await runStandalone(`export function test(): number {
          const e: any[] = [["a", "bb"], ["ccc", "dddd"]];
          return (e[1][0] as string).length + (e[0][1] as string).length;
        }`),
      ).toBe(5);
    });

    it("string CONTENT round-trips (charCodeAt), not just length", async () => {
      expect(
        await runStandalone(`export function test(): number {
          const e: any[] = [["ab", "Xy"]];
          const s = e[0][1] as string;
          return s.charCodeAt(0); // 'X' = 88
        }`),
      ).toBe(88);
    });
  });

  // (#2190b) HETEROGENEOUS inner-tuple read-back. An inner tuple of an `any[]`
  // mixing a native string with a number/boolean previously DROPPED the
  // off-kind element at construction (the first-element heuristic picked a
  // homogeneous vec — `$AnyString[]` for string-first, `f64[]` for number-first
  // — then `f64.const N; drop` / `extern.convert_any; __unbox_number` the other
  // element to a null/NaN). `compileArrayLiteral` now widens such a heterogeneous
  // literal to an externref vec (under native strings + an `any` contextual
  // element type), so each element is boxed by its own static type and reads back
  // correctly. The `(number|string)[]` *union*-typed literal stays on its prior
  // path (not an `any` context) — a distinct representation, untouched here.
  describe("#2190b heterogeneous inner-tuple read-back", () => {
    it('string-first [["a", 7]] — e[0][1] reads the number', async () => {
      expect(
        await runStandalone(`export function test(): number {
          const e: any[] = [["a", 7]];
          return e[0][1] as number;
        }`),
      ).toBe(7);
    });

    it('string-first [["a", 7]] — e[0][0] still reads the string', async () => {
      expect(
        await runStandalone(`export function test(): number {
          const e: any[] = [["a", 7]];
          return (e[0][0] as string).length;
        }`),
      ).toBe(1);
    });

    it('number-first [[7, "ab"]] — e[0][1] reads the string', async () => {
      expect(
        await runStandalone(`export function test(): number {
          const e: any[] = [[7, "ab"]];
          return (e[0][1] as string).length;
        }`),
      ).toBe(2);
    });

    it('number-first [[7, "ab"]] — e[0][0] still reads the number', async () => {
      expect(
        await runStandalone(`export function test(): number {
          const e: any[] = [[7, "ab"]];
          return e[0][0] as number;
        }`),
      ).toBe(7);
    });

    it("three-element mixed [string, number, string]", async () => {
      expect(
        await runStandalone(`export function test(): number {
          const e: any[] = [["a", 9, "ccc"]];
          return (e[0][2] as string).length + (e[0][1] as number);
        }`),
      ).toBe(12);
    });

    it("boolean+number heterogeneous tuple preserves the boolean tag", async () => {
      expect(
        await runStandalone(`export function test(): number {
          const e: any[] = [[true, 7]];
          return (e[0][0] as boolean) ? 1 : 0;
        }`),
      ).toBe(1);
    });

    it('flat any[] [0, "last"] reads the string element', async () => {
      expect(
        await runStandalone(`export function test(): number {
          const a: any[] = [0, "last"];
          return (a[1] as string).length;
        }`),
      ).toBe(4);
    });

    // Regression guards — fast paths must stay byte-identical.
    it("pure number[][] nested indexing unchanged", async () => {
      expect(
        await runStandalone(`export function test(): number {
          const a = [[1, 2], [3, 4]];
          return a[1][0];
        }`),
      ).toBe(3);
    });

    it("pure string[] indexing unchanged", async () => {
      expect(
        await runStandalone(`export function test(): number {
          const a = ["x", "yy"];
          return a[1].length;
        }`),
      ).toBe(2);
    });
  });
});
