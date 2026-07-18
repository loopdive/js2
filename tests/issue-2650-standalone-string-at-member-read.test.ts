// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

// #2650 — Regression guard (standalone / no-JS-host).
//
// `String.prototype.at(i)` returns a NULLABLE native AnyString ref (an
// out-of-range index yields `undefined`). An earlier bug flattened a member
// read (`.length`, `.charCodeAt`, chained methods) on that nullable receiver to
// an empty-string path, so `"abcd".at(2).length` read `0` and
// `"abcd".at(2).charCodeAt(0)` read `0` even though `at` itself returned the
// right character. This was fixed alongside the #2644/#2648/#2161 native-string
// nullable work; the guard locks the member-read-through-`at` behavior in for
// standalone codegen.
//
// Raw Wasm exports return i32, so boolean results come back as 1/0 — assertions
// below use numeric expectations accordingly.

async function runStandalone(src: string): Promise<number> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => number }).test();
}

// [label, source, expected]
const cases: [string, string, number][] = [
  [".length on at() result", `export function test(): number { const c = "abcd".at(2)!; return c.length; }`, 1],
  [
    ".charCodeAt on at() result",
    `export function test(): number { return "abcd".at(2)!.charCodeAt(0); }`,
    99, // "c"
  ],
  [
    "negative-index at() then .charCodeAt",
    `export function test(): number { return "abcd".at(-1)!.charCodeAt(0); }`,
    100, // "d"
  ],
  [
    "chained .toUpperCase on at() result equals uppercase",
    `export function test(): number { return "abcd".at(2)!.toUpperCase() === "C" ? 1 : 0; }`,
    1,
  ],
  ["chained .at on at() result", `export function test(): number { return "abcd".at(2)!.at(0) === "c" ? 1 : 0; }`, 1],
  [
    "OOB at() optional-chained .length coalesces",
    `export function test(): number { return "abcd".at(99)?.length ?? -1; }`,
    -1,
  ],
];

describe("#2650 member read on String.prototype.at() result (standalone, nullable native string)", () => {
  for (const [label, src, expected] of cases) {
    it(label, async () => {
      expect(await runStandalone(src)).toBe(expected);
    });
  }
});
