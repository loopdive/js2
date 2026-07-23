// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3183 — standalone: any-typed array receiver — dynamic-path for-in / string-key
 * reads.
 *
 * When the receiver's STATIC type is `any`, `resolveArrayInfo` fails and both
 * for-in and a computed `arr[k]` route through the dynamic `$Object` runtime.
 * A real JS array in standalone lowers to a `__vec_<elemKind>` struct subtyping
 * `$__vec_base` (#2186), NOT a `$Object` — so three helpers on the for-in /
 * string-key path (`__object_keys_forin` / `__extern_has` / `__extern_get`)
 * treated "not `$Object`" as "no properties":
 *   - for-in over an any-typed array yielded ZERO iterations (empty key vec);
 *   - a string-key element read (`arr[k]` with a string `k`, or `arr["1"]`)
 *     answered `undefined`;
 *   - `arr["length"]` answered `undefined`.
 *
 * `fillDynamicForinVecArms` (object-runtime.ts) splices `$__vec_base` arms into
 * all three at finalize, reusing the existing vec-aware helpers (`number_toString`,
 * `__str_to_number`, `__extern_get_idx`). Standalone-only; host output is
 * byte-identical (the native object runtime is not even emitted in host mode).
 *
 * Every case compiles standalone and must instantiate with ZERO host imports.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandaloneNum(src: string): Promise<number> {
  const r = await compile(src, { fileName: "test.ts", target: "standalone", nativeStrings: true });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  const mod = await WebAssembly.compile(r.binary!);
  const imports = WebAssembly.Module.imports(mod).map((i) => `${i.module}::${i.name}`);
  expect(imports, "standalone module must have zero host imports").toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary!, {});
  return (instance.exports as { test(): number }).test();
}

describe("#3183 — standalone dynamic-path for-in / string-key over an any-typed array", () => {
  it("face A: for-in over an any-typed array literal counts every index key", async () => {
    expect(
      await runStandaloneNum(`export function test(): number {
        var arr: any = [5, 6];
        let n = 0;
        for (var k in arr) { n = n + 1; }
        return n;
      }`),
    ).toBe(2);
  });

  it("face A: aliased typed number[] local enumerates and reads via for-in", async () => {
    expect(
      await runStandaloneNum(`export function test(): number {
        const src = [10, 20, 30];
        var a: any = src;
        let s = 0;
        for (var k in a) { s = s + a[k]; }
        return s;
      }`),
    ).toBe(60);
  });

  it("face A: empty any-typed array enumerates zero keys", async () => {
    expect(
      await runStandaloneNum(`export function test(): number {
        var a: any = [];
        let n = 0;
        for (var k in a) { n = n + 1; }
        return n;
      }`),
    ).toBe(0);
  });

  it("face B: string-key element read on an any-typed vec answers the element", async () => {
    expect(
      await runStandaloneNum(`export function test(): number {
        const a: any = [7, 8, 9];
        const k: any = "1";
        return a[k];
      }`),
    ).toBe(8);
  });

  it("face B: static string-literal index read answers the element", async () => {
    expect(
      await runStandaloneNum(`export function test(): number {
        const a: any = [7, 8, 9];
        return a["2"];
      }`),
    ).toBe(9);
  });

  it('face B: `arr["length"]` on an any-typed vec answers the length', async () => {
    expect(
      await runStandaloneNum(`export function test(): number {
        const a: any = [7, 8, 9];
        return a["length"];
      }`),
    ).toBe(3);
  });

  it("face C: for-in body read (arr[k]) sums every element", async () => {
    expect(
      await runStandaloneNum(`export function test(): number {
        var arr: any = [5, 6, 7];
        let s = 0;
        for (var k in arr) { s = s + arr[k]; }
        return s;
      }`),
    ).toBe(18);
  });

  // (2026-07-23 re-pin, tech-lead authorized) These two originally pinned the
  // legacy undefined→0-in-f64 shortcut. That shortcut belongs to `null`, not
  // `undefined`: ToNumber(undefined) is NaN (`Number(undefined) === NaN`), and
  // the coercion table's documented split is "null → f64.const 0 / undefined →
  // f64.const NaN". The current pipeline answers the spec-correct NaN, so the
  // old `toBe(0)` encoded a superseded convention — this is a stale-test fix,
  // not behavior-bending. `Number.isNaN` because `NaN !== NaN`.
  it("OOB string-key read answers undefined (→ NaN in a number context)", async () => {
    expect(
      Number.isNaN(
        await runStandaloneNum(`export function test(): number {
        var a: any = [1, 2];
        return a["5"];
      }`),
      ),
    ).toBe(true);
  });

  it("non-numeric non-length string key answers undefined (→ NaN)", async () => {
    expect(
      Number.isNaN(
        await runStandaloneNum(`export function test(): number {
        var a: any = [1, 2];
        return a["foo"];
      }`),
      ),
    ).toBe(true);
  });

  it("regression guard: for-in over a plain any-typed object is unchanged", async () => {
    expect(
      await runStandaloneNum(`export function test(): number {
        var o: any = { a: 1, b: 2, c: 3 };
        let n = 0;
        for (var k in o) { n = n + 1; }
        return n;
      }`),
    ).toBe(3);
  });

  it("regression guard: string-key read on a plain any-typed object is unchanged", async () => {
    expect(
      await runStandaloneNum(`export function test(): number {
        var o: any = { x: 7 };
        return o["x"];
      }`),
    ).toBe(7);
  });
});
