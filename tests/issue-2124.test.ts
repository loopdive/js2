// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2124 — explicit `undefined` (and explicit `NaN` for lastIndexOf) passed for
// an optional string-index arg was coerced to NaN/0 instead of the per-method
// default, on both the JS-host string-import path and the native string path.
//
// Spec: an explicit `undefined` index arg is equivalent to an absent one
// (substring/slice end → length; lastIndexOf from → +∞ i.e. search from the
// end; endsWith end → length), and `repeat` truncates ToIntegerOrInfinity
// BEFORE the range check (so `repeat(-0.5)` is `repeat(-0)` → "", not a throw).

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

// The JS-host string-import lane (`nativeStrings: false`) was removed by #6979
// S7; the JS target always uses native strings. The second lane is now the
// no-host `target: "standalone"` build of the same native string path.
async function run(src: string, fn: string, standalone: boolean): Promise<number> {
  const r = await compile(src, {
    fileName: "test.ts",
    skipDiagnostics: true,
    ...(standalone ? { target: "standalone" as const } : {}),
  });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const io = r.importObject;
  const { instance } = await WebAssembly.instantiate(r.binary, io);
  (io as { __setExports?: (e: WebAssembly.Exports) => void }).__setExports?.(instance.exports);
  return (instance.exports as Record<string, () => number>)[fn]!();
}

// Each case asserts on BOTH targets (JS environment + standalone).
function bothBackends(name: string, src: string, fn: string, expected: number): void {
  it(`${name} (js)`, async () => {
    expect(await run(src, fn, false)).toBe(expected);
  });
  it(`${name} (standalone)`, async () => {
    expect(await run(src, fn, true)).toBe(expected);
  });
}

describe("#2124 explicit undefined for optional string-index args defaults correctly", () => {
  bothBackends(
    "substring(1, undefined) → to end",
    `export function t(): number { return "hello".substring(1, undefined).length; }`,
    "t",
    4,
  );
  bothBackends(
    "slice(1, undefined) → to end",
    `export function t(): number { return "hello".slice(1, undefined).length; }`,
    "t",
    4,
  );
  bothBackends(
    'lastIndexOf("a", NaN) → search from end',
    `export function t(): number { return "aba".lastIndexOf("a", NaN); }`,
    "t",
    2,
  );
  bothBackends(
    'lastIndexOf("a", undefined) → search from end',
    `export function t(): number { return "aba".lastIndexOf("a", undefined); }`,
    "t",
    2,
  );
  bothBackends(
    'endsWith("lo", undefined) → end defaults to length',
    `export function t(): number { return "hello".endsWith("lo", undefined) ? 1 : 0; }`,
    "t",
    1,
  );
  bothBackends(
    "repeat(-0.5) → ToInteger is -0, no RangeError",
    `export function t(): number { return "a".repeat(-0.5).length; }`,
    "t",
    0,
  );

  // Regression guards: absent-arg and normal-arg behavior must be unchanged.
  bothBackends(
    "substring(1) absent end still goes to length",
    `export function t(): number { return "hello".substring(1).length; }`,
    "t",
    4,
  );
  bothBackends(
    "substring(1, 3) explicit end still honored",
    `export function t(): number { return "hello".substring(1, 3).length; }`,
    "t",
    2,
  );
  bothBackends(
    "repeat(3) normal count still works",
    `export function t(): number { return "ab".repeat(3).length; }`,
    "t",
    6,
  );
});
