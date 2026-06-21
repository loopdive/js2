// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #2160 (senior-dev slice) — `Number(arr)` array→primitive coercion in standalone.
 *
 * `Number(arr)` is §7.1.4 ToNumber → §7.1.1.1 ToPrimitive(no hint) on an Array,
 * whose OrdinaryToPrimitive falls to `arr.toString()` (join ","), then §7.1.4.1
 * StringToNumber. In native-strings (standalone / WASI) mode there is no host
 * `__unbox_number`, and the generic struct-ToPrimitive path has no array case,
 * so `Number([5])` silently yielded NaN.
 *
 * Fix (calls.ts `Number()` handler) — WITHOUT a new ad-hoc coercion site: reuse
 * the SAME two existing, already-sanctioned lowerings —
 * `tryEmitArrayToStringNative` (the `String(arr)` array→string half, PR #1640)
 * to get the native-string ref, then the EXISTING `__str_to_number` engine call
 * (the very helper the string-ref `Number(str)` arm already uses). No new
 * coercion call-site is introduced, so the #2108 drift gate is unmoved.
 *
 * Out of scope (pre-existing, NOT regressed): a bare `Number([])` literal infers
 * `never[]`, which the native array-join path mishandles exactly like the
 * pre-existing `String([])` / `[].toString()` bare-literal crash. The guard
 * skips that case so `Number([])` falls through to main's NaN behaviour (no
 * crash). A *typed* empty array (`const a: number[] = []`) lowers correctly → 0.
 *
 * All cases instantiate with an EMPTY import object — no JS host needed.
 */

type Case = { name: string; src: string; want: number };

const CASES: ReadonlyArray<Case> = [
  // Number([5]) → "5" → 5
  { name: "single", src: `return Number([5]);`, want: 5 },
  // Number([42]) * 2 — proves the value flows as a real f64
  { name: "arith", src: `return Number([42]) * 2;`, want: 84 },
  // Number(["7"]) → "7" → 7 (string-element array)
  { name: "strElem", src: `return Number(["7"]);`, want: 7 },
  // Number([3.14]) → "3.14" → 3.14
  { name: "frac", src: `return Number([3.14]);`, want: 3.14 },
  // Number([-5]) → "-5" → -5
  { name: "neg", src: `return Number([-5]);`, want: -5 },
  // Number([0]) → "0" → 0
  { name: "zero", src: `return Number([0]);`, want: 0 },
  // Number([1,2]) → "1,2" → NaN (multi-element joins with a comma → non-numeric)
  { name: "multiNaN", src: `return isNaN(Number([1, 2])) ? 1 : 0;`, want: 1 },
  // Number(typed empty array) → "" → 0
  { name: "typedEmpty", src: `const a: number[] = []; return Number(a);`, want: 0 },
  // Number(["12"]) used in an arithmetic chain
  { name: "strArith", src: `return Number(["12"]) + Number([8]);`, want: 20 },
  // No-regression: Number on non-array values keeps working.
  { name: "noregressStr", src: `return Number("42");`, want: 42 },
  { name: "noregressNum", src: `return Number(3.5);`, want: 3.5 },
  { name: "noregressBool", src: `return Number(true);`, want: 1 },
  // No-regression: String(arr) (PR #1640) still works alongside.
  { name: "stringArrStillWorks", src: `return String([1, 2, 3]).length;`, want: 5 },
  // No-crash: bare Number([]) (never[]) falls through to NaN, doesn't trap.
  { name: "bareEmptyNoCrash", src: `return isNaN(Number([])) ? 1 : 0;`, want: 1 },
];

async function runCase(c: Case): Promise<number> {
  const src = `export function test(): number { ${c.src} }`;
  const r = await compile(src, { target: "standalone" });
  expect(r.success, `${c.name}: ${r.errors.map((e) => e.message).join("; ")}`).toBe(true);
  // No host-import leak — pure standalone module.
  expect(
    (r.imports ?? []).map((i) => i.name),
    `${c.name} imports`,
  ).toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): number }).test();
}

describe("#2160 (senior-dev) — Number(array) coercion in standalone", () => {
  for (const c of CASES) {
    it(`Number(arr): ${c.name}`, async () => {
      expect(await runCase(c)).toBe(c.want);
    });
  }
});
