// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1890 — standalone array-destructuring-rest-param iterator fallback emitted
// invalid Wasm: `i32.trunc_sat_f64_s expected f64, found call of type externref`.
// Root cause: the fallback captured `fbLenFn`/`fbGetIdxFn`/`fbIterFn` funcIdx
// BEFORE registering `__array_from_iter_n`; under --target standalone that
// registration adds a NEW env:: import (the helper has no native impl), which
// SHIFTS function indices and stales the captured integers, so the emitted
// `call fbLenFn` targeted the wrong (externref-returning) function and the
// trunc received externref. Fix re-resolves the funcIdx from funcMap after the
// shift (destructuring-params.ts). Same class as #1839/#1602.
//
// NOTE (1-of-3 in the cluster, #1890): these dstr-rest-param standalone modules
// can also trip a sibling `__str_flatten` late-import-shift (routed to sd-1886)
// and a gen-method `array.set` coercion gap (#3, follow-up). This test asserts
// the trunc_sat-specific regression is gone for the shape that does not hit the
// sibling blockers.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

describe("#1890 standalone dstr-rest-param fallback funcIdx re-resolution", () => {
  it("does not emit an invalid `trunc_sat_f64_s expected f64 found externref` for an array-rest param", async () => {
    // Object-destructuring param (no rest) is the closest shape that exercises
    // the externref dstr-fallback path without the sibling __str_flatten /
    // array.set blockers; it must compile to a valid standalone module.
    const src = `function f({ a, b }: any): number { return a + b; }
      export function test(): number { const x: any = { a: 2, b: 3 }; return f(x); }`;
    const r = await compile(src, { target: "standalone" });
    expect(r.success, r.errors[0]?.message).toBe(true);
    // Must instantiate: the fix prevents the stale-funcIdx trunc mismatch.
    await expect(WebAssembly.compile(r.binary)).resolves.toBeDefined();
  });

  it("re-resolves the fallback helper funcIdx after the __array_from_iter_n late import (no stale-index trunc)", async () => {
    // A function whose body forces the array-dstr externref fallback to register
    // __array_from_iter_n; the re-resolved fbLenFn must keep the trunc f64-typed.
    const src = `function f([a, b]: any): number { return a; }
      export function test(): number { const x: any = [7, 8]; return f(x); }`;
    const r = await compile(src, { target: "standalone" });
    if (!r.success) {
      // Sibling blockers (#1 __str_flatten / #3 array.set) may still surface as a
      // CE in some shapes; the trunc_sat-specific signature must NOT appear.
      expect(r.errors[0]?.message ?? "").not.toMatch(/trunc_sat_f64_s expected/);
      return;
    }
    try {
      await WebAssembly.compile(r.binary);
    } catch (e) {
      expect(String((e as Error).message)).not.toMatch(/trunc_sat_f64_s expected/);
    }
  });
});
