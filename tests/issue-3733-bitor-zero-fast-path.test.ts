// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3733 — `x | 0` / `x ^ 0` (the common "coerce to int32" idiom) ran the full
// float-based ToInt32 sequence on BOTH operands, including the compile-time
// constant `0` on the right — pure dead work, since ToInt32(0) is trivially
// 0 and OR/XOR with 0 is the identity. `binary-ops.ts`'s legacy AST-direct
// codegen already special-cased `expr | 0`; the IR lowerer
// (`src/ir/lower.ts`, `case "binary"`) never did, so any function compiled
// through IR — e.g. the landing-page `loop.ts` benchmark's
// `s = (s + i) | 0` — paid the full double-ToInt32 cost every iteration.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
// compileAndRunStubs's minimal env-only imports omit "string_constants" and
// fail to instantiate when this file runs isolated (CI's root-test gate
// singleFork mode) — pre-existing, unrelated to #3733. Use the full host
// import object instead.
import { compileAndRunBuildImports as compileAndRun } from "./helpers/compile.js";

async function wat(src: string): Promise<string> {
  const r = await compile(src, {
    skipSemanticDiagnostics: true,
    emitWat: true,
  });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  return r.wat;
}

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("#3733 — bitwise-with-literal-zero fast path", () => {
  it("`x | 0` runs ToInt32 exactly once (on `x`), not twice (once per operand)", async () => {
    const w = await wat(`export function run(x: number): number { return x | 0; }`);
    // (#3739) emitJsToInt32's fast path decomposes the f64's IEEE-754 bits
    // instead of the old div/floor modulo-reduction — i64.reinterpret_f64 is
    // its first instruction, so counting it pins "ToInt32 runs once, not
    // twice" the same way the old f64.div count did. The dynamic operand `x`
    // still legitimately needs it (real ToInt32 wraparound is observable);
    // the fast path's entire point is that the constant-zero operand's
    // ToInt32 (which would make it TWICE) is elided.
    expect(count(w, "i64.reinterpret_f64")).toBe(1);
    // No bitwise instruction either — `x | 0` is emitted as pure ToInt32(x),
    // not `ToInt32(x) | ToInt32(0)`.
    expect(w).not.toContain("i32.or");
  });

  it("`x ^ 0` gets the same identity fast path", async () => {
    const w = await wat(`export function run(x: number): number { return x ^ 0; }`);
    expect(count(w, "i64.reinterpret_f64")).toBe(1);
    expect(w).not.toContain("i32.xor");
  });

  it("`x & 0` is unaffected (not in scope — always 0, but not identity-folded here)", async () => {
    // Sanity check that the fast path is scoped to |/^ only, per the issue.
    // `x & 0` still compiles correctly; whether it also gets a fast path is
    // tracked separately, not asserted here.
    const e = await compileAndRun(`export function band(a: number): number { return a & 0; }`);
    expect(e.band(5)).toBe(0);
    expect(e.band(-5)).toBe(0);
  });

  it("real ToInt32 wraparound on the dynamic operand is still correct", async () => {
    const e = await compileAndRun(`
      export function bor(a: number): number { return a | 0; }
      export function bxor(a: number): number { return a ^ 0; }
    `);
    expect(e.bor(2 ** 32 + 5)).toBe(5);
    expect(e.bor(4294967295)).toBe(-1);
    expect(e.bor(2147483648)).toBe(-2147483648);
    expect(e.bor(NaN)).toBe(0);
    expect(e.bor(Infinity)).toBe(0);
    expect(e.bor(-Infinity)).toBe(0);
    expect(e.bor(1.5)).toBe(1);
    expect(e.bor(-1.5)).toBe(-1);
    expect(e.bxor(-5)).toBe(-5);
    expect(e.bxor(NaN)).toBe(0);
  });

  it("literal-zero on the LEFT (`0 | x`) still compiles correctly (general path, not the fast path)", async () => {
    const e = await compileAndRun(`export function run(a: number): number { return 0 | a; }`);
    expect(e.run(5)).toBe(5);
    expect(e.run(-5)).toBe(-5);
  });

  it("a tight accumulator loop using `s = (s + i) | 0` produces the correct wrapped sum", async () => {
    // Mirrors website/playground/examples/benchmarks/loop.ts (`bench_loop`).
    const e = await compileAndRun(`
      export function run(): number {
        let s = 0;
        for (let i = 0; i < 1000000; i++) s = (s + i) | 0;
        return s;
      }
    `);
    let expected = 0;
    for (let i = 0; i < 1000000; i++) expected = (expected + i) | 0;
    expect(e.run()).toBe(expected);
  });
});
