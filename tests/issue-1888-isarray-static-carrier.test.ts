// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1888 — `Array.isArray(<statically-typed arg>)` claimed EVERY ref is an array.
//
// `call-builtin-static.ts` has a compile-time fast path for `Array.isArray(x)`
// when the argument's Wasm type is statically known. It decided array-ness with
//
//     const isArr = argWasmType.kind === "ref" || argWasmType.kind === "ref_null";
//
// i.e. "any heap reference is an Array". Every value the compiler can type
// statically is a ref — a native string, a closed object-literal struct, a
// class instance, `$Date` — so the fast path answered `true` for all of them.
//
// Measured on a 5-case standalone probe before the fix: `Array.isArray("abc")`,
// `Array.isArray({0:12,1:9,length:2})` and `Array.isArray(new Date(0))` all
// returned `true`; only the genuine array literal was right, and only by
// accident. The bug hid for so long because laundering the same value through
// an `any`-typed local takes the OTHER branch (externref → the finalize-filled
// native `__extern_is_array` predicate), which is correct — so the slow path
// was tested and the fast path, which disagreed with it, was not.
//
// The fix routes the fast path through `isArrayCarrierTypeIdx`, the static
// counterpart of the `ref.test` chain `fillExternIsArray` bakes: only a
// `__vec_*` leaf, the template vector or `$ObjVec` is an array carrier; the
// abstract `__vec_base` and the packed byte carriers stay excluded (#2047/#3562).
//
// test262 effect (measured 2026-08-16, `built-ins/Array/isArray/`, standalone
// lane, 29 files): 23/29 → 27/29 pass, no regressions in the directory.
//
// KNOWN RESIDUALS, deliberately not fixed here (both predate this change and
// affect the runtime predicate too, so neither is reachable from the static
// path alone):
//   - `Array.isArray(arguments)` → `true`. The arguments object genuinely
//     lowers to a `__vec_*` carrier, so both the static and the runtime
//     predicate classify it as an array. Distinguishing it needs a brand bit on
//     the carrier — same shape as the documented Float64Array false positive.
//   - `Array.isArray(<revoked Proxy>)` must throw a TypeError (§7.2.2 step 3);
//     standalone has no Proxy revocation state to consult.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(source: string): Promise<number> {
  const r = await compile(source, {
    fileName: "issue-1888-isarray.ts",
    target: "standalone",
    skipSemanticDiagnostics: true,
  });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary)).toBe(true);
  const stub = new Proxy({}, { get: () => () => 0 });
  const { instance } = await WebAssembly.instantiate(r.binary, { env: stub } as unknown as WebAssembly.Imports);
  return (instance.exports.test as () => number)();
}

describe("#1888 Array.isArray static fast path only accepts real array carriers", () => {
  it("a string literal is not an array", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          return Array.isArray("abc") ? 1 : 0;
        }
      `),
    ).toBe(0);
  });

  it("an array-LIKE object literal is not an array", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          return Array.isArray({ 0: 12, 1: 9, length: 2 }) ? 1 : 0;
        }
      `),
    ).toBe(0);
  });

  it("a Date instance is not an array", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          return Array.isArray(new Date(0)) ? 1 : 0;
        }
      `),
    ).toBe(0);
  });

  it("a class instance is not an array", async () => {
    expect(
      await runStandalone(`
        class Box { x: number = 1; }
        export function test(): number {
          return Array.isArray(new Box()) ? 1 : 0;
        }
      `),
    ).toBe(0);
  });

  // The true-positive side of the ratchet: narrowing the fast path must not
  // start answering `false` for genuine arrays of any element carrier.
  it("real arrays are still arrays, across element carriers", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          const nums: number[] = [1, 2, 3];
          const strs: string[] = ["a"];
          const bools: boolean[] = [true];
          let bits = 0;
          if (Array.isArray([1, 2, 3])) bits += 1;
          if (Array.isArray(nums)) bits += 2;
          if (Array.isArray(strs)) bits += 4;
          if (Array.isArray(bools)) bits += 8;
          return bits;
        }
      `),
    ).toBe(15);
  });

  // The fast path and the `any`-laundered slow path must agree — the disagreement
  // between them is what let this bug survive.
  it("static and any-laundered answers agree for a non-array", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          const d: any = new Date(0);
          const viaStatic = Array.isArray(new Date(0)) ? 1 : 0;
          const viaAny = Array.isArray(d) ? 2 : 0;
          return viaStatic + viaAny;
        }
      `),
    ).toBe(0);
  });
});
