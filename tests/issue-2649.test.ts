// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.ts";

// #2649 — In `--target standalone`, `TypedArray.prototype.subarray(begin?, end?)`
// returned a view whose `.length` read as 0 regardless of begin/end (the element
// data was reachable, so only the length was wrong).
//
// Root cause: `subarray` returns a `$__subview_<elem>` struct (a window sharing
// the parent's backing array). The `.length` read is TS-typed as the TypedArray,
// so the length dispatch `ref.test`-ed the receiver against the concrete
// `$__vec_<elem>` type — which the subview (a sibling subtype of `$__vec_base`,
// not the vec) FAILS — and fell back to `f64.const 0`. Fixed in
// property-access-dispatch.ts: when the compiled receiver's own static type is a
// length-prefixed {length,data} struct (the subview), read field 0 directly from
// that type instead of ref.test-ing the mismatched vec type.

async function runStandalone(src: string): Promise<number> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("; ")).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => number }).test();
}

async function runHost(src: string): Promise<number> {
  const r = await compile(src, { fileName: "test.ts" });
  expect(r.success, r.errors.map((e) => e.message).join("; ")).toBe(true);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  return (instance.exports as { test: () => number }).test();
}

// [label, source, expected]
const cases: [string, string, number][] = [
  [
    "subarray(begin).length",
    `export function test(): number { const a = new Int8Array([10,11,12,13]); return a.subarray(1).length; }`,
    3,
  ],
  [
    "subarray(begin,end).length",
    `export function test(): number { const a = new Int8Array([10,11,12,13]); return a.subarray(0,2).length; }`,
    2,
  ],
  [
    "subarray() full-range length",
    `export function test(): number { const a = new Int8Array([10,11,12,13]); return a.subarray().length; }`,
    4,
  ],
  [
    "negative begin clamps to length",
    `export function test(): number { const a = new Int8Array([10,11,12,13]); return a.subarray(-2).length; }`,
    2,
  ],
  [
    "negative end clamps to length",
    `export function test(): number { const a = new Int8Array([10,11,12,13]); return a.subarray(1,-1).length; }`,
    2,
  ],
  [
    "empty window subarray(2,2).length",
    `export function test(): number { const a = new Int8Array([1,2,3,4]); return a.subarray(2,2).length; }`,
    0,
  ],
  [
    "Uint16Array subarray length",
    `export function test(): number { const a = new Uint16Array([1,2,3,4,5]); return a.subarray(1).length; }`,
    4,
  ],
  [
    "Int32Array subarray length",
    `export function test(): number { const a = new Int32Array([1,2,3,4]); return a.subarray(0,3).length; }`,
    3,
  ],
  [
    "Float64Array subarray length",
    `export function test(): number { const a = new Float64Array([1,2,3,4]); return a.subarray(2).length; }`,
    2,
  ],
  [
    "nested subarray length",
    `export function test(): number { const a = new Int8Array([1,2,3,4,5,6]); return a.subarray(1).subarray(1).length; }`,
    4,
  ],
  [
    "length AND element value both correct (len*100 + s[0])",
    `export function test(): number { const a = new Int8Array([10,11,12,13]); const s = a.subarray(1); return s.length * 100 + s[0]; }`,
    311,
  ],
  [
    "plain typed-array .length regression guard",
    `export function test(): number { const a = new Int8Array([1,2,3]); return a.length; }`,
    3,
  ],
];

describe("#2649 TypedArray.prototype.subarray view length (standalone)", () => {
  describe("standalone (no JS host)", () => {
    for (const [label, src, expected] of cases) {
      it(label, async () => {
        expect(await runStandalone(src)).toBe(expected);
      });
    }
  });

  // Host mode uses copy (slice) semantics for subarray, so length was never
  // broken there — parity guard on the headline case.
  describe("gc (JS host) parity", () => {
    it("subarray(begin).length", async () => {
      expect(
        await runHost(
          `export function test(): number { const a = new Int8Array([10,11,12,13]); return a.subarray(1).length; }`,
        ),
      ).toBe(3);
    });
  });
});
