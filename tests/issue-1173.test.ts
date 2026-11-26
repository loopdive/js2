// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1173 — js2wasm output uses 'exact' reference types that wasmtime 44 rejects
//
// Two-part regression test:
//
//   1. The compiler-side fix: `markLeafStructsFinal` is gated on `!ctx.wasi`
//      so that `--target wasi` builds no longer encode leaf structs as
//      `(sub final $T)`. That declaration is what causes Binaryen ≥ 124, when
//      run with `wasm-opt --all-features`, to convert `(ref $T)` references
//      into `(ref exact $T)` — an encoding wasmtime ≤ 44 rejects with:
//        "custom descriptors required for exact reference types"
//
//      Test: compile the array-sum benchmark with `target: "wasi"` and confirm
//      the binary contains no `0x4F` (sub_final) opcode bytes. (Type encodings
//      are fixed-position byte sequences, so this byte-presence check is a
//      reliable proxy.)
//
//   2. The benchmark-harness fix: the harness passes
//      `--disable-custom-descriptors` to `wasm-opt`, which prevents Binaryen
//      from re-emitting refs as exact even when the source binary still has
//      leaf-final types (e.g. `--target gc` browser builds piped through the
//      same harness).
//
//      Test: assert the flag is present in the harness's wasm-opt arguments.
//      The original harness, `benchmarks/compare-runtimes.ts`, moved to the
//      private labs repo with PR #59 (chore/remove-private-content-from-public,
//      ~2026-04-27; plan/agent-context/dev-1125-bench.md). The public benchmark
//      harness that still runs wasm-opt is the landing-page wasmtime lane,
//      whose flags live in `LANDING_WASM_OPT_ARGS`
//      (scripts/lib/landing-wasmtime-runtime.mjs).

import { describe, it, expect } from "vitest";
import { compile } from "./src/index.js";
import { LANDING_WASM_OPT_ARGS } from "../scripts/lib/landing-wasmtime-runtime.mjs";

const ARRAY_SUM_SOURCE = `
/** @param {number} n @returns {number} */
export function run(n) {
  const values = [];
  for (let i = 0; i < n; i++) {
    values[i] = ((i * 17) ^ (i >>> 3)) & 1023;
  }
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum = (sum + values[i]) | 0;
  }
  return sum | 0;
}
`;

describe("#1173 — no exact-ref encodings in --target wasi output", () => {
  it("compiles array-sum kernel with target: wasi", async () => {
    const result = await compile(ARRAY_SUM_SOURCE, { fileName: "array-sum.js", allowJs: true, target: "wasi" });
    expect(result.success).toBe(true);
    expect(result.binary.byteLength).toBeGreaterThan(0);
  });

  it("does not declare any struct as `sub final` for --target wasi (#1173)", async () => {
    // markLeafStructsFinal is now skipped for wasi, so no struct type should
    // be encoded with the sub_final opcode. Without this, `wasm-opt
    // --all-features` re-emits `(ref $T)` as `(ref exact $T)`, which wasmtime
    // 44 rejects with "custom descriptors required for exact reference types".
    const result = await compile(ARRAY_SUM_SOURCE, { fileName: "array-sum.js", allowJs: true, target: "wasi" });
    expect(result.success).toBe(true);

    // The WAT printer emits `(sub final $parent ...)` for any struct whose
    // type-section encoding uses the sub_final (0x4F) opcode. We use that as
    // the source of truth — counting the raw byte 0x4F in the binary is
    // ambiguous because 0x4F is also the `i32.ge_u` instruction opcode.
    expect(result.wat).not.toMatch(/\bsub final\b/);
  });

  it("still emits `sub final` for the default GC (browser) target — V8 devirt preserved", async () => {
    // The opt-in for V8 devirtualization (#594) is preserved for --target gc.
    // We use a minimal class hierarchy because the array-sum kernel doesn't
    // create any subtyped structs of its own; the leaf-final structs in the
    // wasi output above come from runtime helpers the compiler emits.
    const src = `
      class A { x: number = 0; }
      class B extends A { y: number = 0; }
      export function make(): B { return new B(); }
    `;
    const result = await compile(src, { fileName: "leaf.ts", target: "gc" });
    expect(result.success).toBe(true);
    expect(result.wat).toMatch(/\bsub final\b/);
  });

  it("benchmark harness passes --disable-custom-descriptors to wasm-opt", () => {
    // Even with the compiler-side fix, Binaryen will re-encode refs to ANY
    // single-instance type (including arrays, which never have a `sub`
    // clause) as exact when run with --all-features. The harness explicitly
    // disables that proposal so wasmtime 44 keeps loading the optimized
    // binary.
    // benchmarks/compare-runtimes.ts moved to the private labs repo (PR #59);
    // the public wasm-opt harness is the landing wasmtime lane.
    expect(LANDING_WASM_OPT_ARGS).toContain("--disable-custom-descriptors");
  });
});
