// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4222) §10.4.2.4 ArraySetLength step 3 — `arr.length = v` where
// `ToUint32(v) !== ToNumber(v)` is a **RangeError**, not a clamp.
//
// The vec `length` write lowered the value with `i32.trunc_sat_f64_s` and a
// comment saying NaN/Infinity/out-of-range "clamp instead of trapping". A
// saturating truncation is total by construction, so it cannot distinguish
// "too big" from "fine" — `[].length = 4294967296`, `= -1`, `= 1.5`, `= NaN`
// and `= Infinity` all silently succeeded. `new Array(n)` already threw
// correctly for the same values; only the assignment form did not.
//
// The validity test is applied to the f64 directly rather than by
// materialising ToUint32 and comparing back: `ToUint32(v) === ToNumber(v)` is
// exactly "v is an integer in [0, 2^32-1]".
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(src: string, target: "standalone" | "gc"): Promise<unknown> {
  const opts = target === "standalone" ? { target: "standalone" as const } : {};
  const r = await compile(src, opts);
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const imports = target === "standalone" ? {} : buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  return (instance.exports as { test: () => unknown }).test();
}

/** 1 = RangeError, 0 = no throw, -1 = a different error. */
const assignLength = (v: string) => `export function test(): number {
  const a = [];
  try { a.length = ${v}; } catch (e) { return (e instanceof RangeError) ? 1 : -1; }
  return 0;
}`;

describe("#4222 — invalid `arr.length =` values throw RangeError", () => {
  // Each row is a test262 assertion in built-ins/Array/length: 15.4.5.1-3.d-1
  // (2^32), -3.d-2 (2^32+1) and S15.4.5.1_A1.1_T1 (2^32 / -1 / 1.5).
  const cases: Array<[string, string]> = [
    ["2^32 (one past the last array index + 1)", "4294967296"],
    ["2^32 + 1", "4294967297"],
    ["a negative length", "-1"],
    ["a fractional length", "1.5"],
    ["NaN", "NaN"],
    ["Infinity", "Infinity"],
  ];
  for (const [label, value] of cases) {
    for (const target of ["standalone", "gc"] as const) {
      it(`${label} (${target})`, async () => {
        expect(await run(assignLength(value), target)).toBe(1);
      });
    }
  }
});

describe("#4222 — valid `arr.length =` values are unaffected", () => {
  for (const target of ["standalone", "gc"] as const) {
    it(`truncation, extension, zero and -0 still succeed (${target})`, async () => {
      expect(
        await run(`export function test(): number { const a = [0, 1, 2, 3]; a.length = 2; return a.length; }`, target),
      ).toBe(2);
      expect(
        await run(`export function test(): number { const a = [0, 1]; a.length = 5; return a.length; }`, target),
      ).toBe(5);
      expect(
        await run(`export function test(): number { const a = [0, 1]; a.length = 0; return a.length; }`, target),
      ).toBe(0);
      // ToUint32(-0) is 0 and the spec compares with Number `!==`, under which
      // `-0 !== 0` is false — so -0 must NOT throw.
      expect(
        await run(`export function test(): number { const a = [0, 1]; a.length = -0; return a.length; }`, target),
      ).toBe(0);
    });
  }
});
