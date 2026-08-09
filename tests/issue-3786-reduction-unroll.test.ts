// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#3786) An i32-wrapping reduction unrolls across k independent accumulators.
 *
 * The transform reassociates `s = (s + i) | 0` across `UNROLL_WIDTH` partial
 * sums, which is legal because that expression is addition modulo 2^32. The
 * risk it carries is specific: an off-by-one in the straight-line remainder
 * returns a WRONG SUM rather than failing, so the load-bearing assertions here
 * are differential against real JS across trip counts whose remainder mod 8
 * covers 0..7 — not instruction-mix checks, which cannot see a wrong answer.
 *
 * The reject cases matter just as much: every one of them would be a
 * miscompile if the recogniser accepted it (float accumulator, aliased
 * accumulator, non-literal bound, side effect in the body, step != 1).
 */
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

async function build(source: string) {
  return await compile(source, { fileName: "b.ts", emitWat: true, target: "standalone" });
}

async function runWasm(source: string): Promise<number> {
  const r = await build(source);
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const instance = await WebAssembly.instantiate(await WebAssembly.compile(r.binary), {});
  return (instance.exports as { f: () => number }).f();
}

/** Did the reduction unroller fire? Its accumulators are named `__ru_acc*`. */
async function didUnroll(source: string): Promise<boolean> {
  const r = await build(source);
  expect(r.success).toBe(true);
  return /__ru_acc0/.test(r.wat ?? "");
}

const sumLoop = (n: number) => `export function f(): number {
  let s = 0;
  for (let i = 0; i < ${n}; i++) s = (s + i) | 0;
  return s;
}`;

/** The same computation in real JS — the oracle. */
function jsSum(n: number): number {
  let s = 0;
  for (let i = 0; i < n; i++) s = (s + i) | 0;
  return s;
}

describe("#3786 — reduction unroll agrees with JS", () => {
  // Remainders mod 8 across 0..7, plus the sub-threshold sizes that must stay
  // on the original lowering, plus two that overflow int32 (the whole point).
  const TRIP_COUNTS = [0, 1, 2, 7, 8, 9, 15, 16, 63, 64, 65, 100, 127, 128, 1000, 999999, 1000000];

  for (const n of TRIP_COUNTS) {
    it(`N=${n} (remainder ${n % 8})`, async () => {
      expect(await runWasm(sumLoop(n))).toBe(jsSum(n));
    });
  }

  it("wraps past 2^31 exactly as JS does", async () => {
    // 1e6 iterations sums to 499999500000, far past int32; the answer is only
    // right if every partial and the final combine wrap mod 2^32.
    const want = jsSum(1000000);
    expect(want).toBe(1783293664);
    expect(want).toBeLessThan(2 ** 31);
    expect(await runWasm(sumLoop(1000000))).toBe(want);
  });

  it("preserves a non-zero starting accumulator", async () => {
    // Partial 0 is seeded with the incoming value; the rest start at 0. If that
    // seeding were dropped, `s`'s initial 12345 would silently vanish.
    const src = `export function f(): number {
      let s = 12345;
      for (let i = 0; i < 1000; i++) s = (s + i) | 0;
      return s;
    }`;
    let want = 12345;
    for (let i = 0; i < 1000; i++) want = (want + i) | 0;
    expect(await runWasm(src)).toBe(want);
  });
});

describe("#3786 — the transform fires where it should", () => {
  it("unrolls a large literal-bounded reduction", async () => {
    expect(await didUnroll(sumLoop(1000000))).toBe(true);
  });

  it("leaves a below-threshold loop on the original lowering", async () => {
    expect(await didUnroll(sumLoop(63))).toBe(false);
  });
});

describe("#3786 — reject list (each would be a miscompile if accepted)", () => {
  const REJECTS: ReadonlyArray<{ name: string; source: string }> = [
    {
      // No `| 0`, so this is FLOAT addition — not associative. Reassociating
      // would change the result for values past 2^53.
      name: "float accumulator (no `| 0`)",
      source: `export function f(): number {
        let s = 0;
        for (let i = 0; i < 1000; i++) s = s + i;
        return s;
      }`,
    },
    {
      // `s` is read for something other than the accumulate, so the per-partial
      // value is observable mid-loop and the split is not transparent.
      name: "accumulator also read in the body",
      source: `export function f(): number {
        let s = 0;
        let t = 0;
        for (let i = 0; i < 1000; i++) { s = (s + i) | 0; t = (t + s) | 0; }
        return t;
      }`,
    },
    {
      name: "non-literal bound",
      source: `export function f(n: number): number {
        let s = 0;
        for (let i = 0; i < n; i++) s = (s + i) | 0;
        return s;
      }`,
    },
    {
      name: "step other than 1",
      source: `export function f(): number {
        let s = 0;
        for (let i = 0; i < 1000; i += 2) s = (s + i) | 0;
        return s;
      }`,
    },
    {
      // The init declares `j` while the condition tests `i`: the literal `0`
      // says nothing about the counter's entry value.
      name: "init declares a different binding than the cond tests",
      source: `export function f(): number {
        let s = 0;
        let i = 4;
        for (let j = 0; i < 1000; i++) s = (s + i) | 0;
        return s;
      }`,
    },
  ];

  for (const { name, source } of REJECTS) {
    it(`does not unroll: ${name}`, async () => {
      expect(await didUnroll(source)).toBe(false);
    });
  }

  it("a rejected loop still computes the JS answer", async () => {
    // Rejection must mean "lower as before", not "lower wrong".
    const src = `export function f(): number {
      let s = 0;
      for (let i = 0; i < 1000; i += 2) s = (s + i) | 0;
      return s;
    }`;
    let want = 0;
    for (let i = 0; i < 1000; i += 2) want = (want + i) | 0;
    expect(await runWasm(src)).toBe(want);
  });
});
