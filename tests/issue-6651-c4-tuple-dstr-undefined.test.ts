// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#6651 cluster C, slice C4) Array binding patterns over a TUPLE-struct source.
//
// A parameter default such as `{ w: [7, 8] }` makes the checker type `w` as the
// tuple `[number, number]`, so the destructure reads a 2-field `(f64, f64)`
// struct. Two defects on that lane, both observable as the test262
// `dstr/*dflt-obj-ptrn-prop-ary` family (`SameValue(«NaN», «undefined»)`):
//
//   1. EXHAUSTED elements — a pattern `[a, b, c]` longer than the tuple
//      `break`s out of the element loop, leaving `c` at its zero-initialised
//      local: a null externref, i.e. JS `null`, and its own default never ran.
//      §8.6.3 reads `undefined` for every element past the end.
//   2. The SENTINEL — an `undefined` element rides the f64 field as the
//      `UNDEF_F64_BITS` signaling NaN; binding it into a dynamic (externref)
//      local boxed it as the NUMBER NaN.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runJsStandalone(source: string): Promise<number> {
  const result = await compile(source, { target: "standalone", fileName: "probe.js", skipSemanticDiagnostics: true });
  expect((result.errors ?? []).filter((e) => e.severity !== "warning")).toEqual([]);
  expect(result.imports ?? []).toEqual([]);
  const instance = await WebAssembly.instantiate(result.binary!, {});
  return (instance.instance.exports as { test: () => number }).test();
}

async function runJsHost(source: string): Promise<number> {
  const result = await compile(source, { fileName: "probe.js", skipSemanticDiagnostics: true });
  expect((result.errors ?? []).filter((e) => e.severity !== "warning")).toEqual([]);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as unknown as WebAssembly.Imports);
  return (instance.exports as { test: () => number }).test();
}

// The test262 `statements/function/dstr/dflt-obj-ptrn-prop-ary.js` body.
const PROP_ARY = `
var score = 0;
function f({ w: [x, y, z] = [4, 5, 6] } = { w: [7, undefined, ] }) {
  if (x === 7) score += 1;
  if (y === undefined) score += 2;
  if (typeof y === "undefined") score += 4;
  if (String(y) === "undefined") score += 8;
  if (z === undefined) score += 16;
  if (String(z) === "undefined") score += 32;
}
f();
export function test() { return score; }`;

// Elements past the end of the default's tuple: plain, own default, nested
// defaults, and a nested pattern with NO default (must throw a TypeError).
const EXHAUSTED = `
var score = 0;
function g1({ w: [a, b, c] = [4, 5, 6] } = { w: [7, 8] }) { if (String(c) === "undefined") score += 1; }
g1();
function g2({ w: [a, b, c = 9] } = { w: [7, 8] }) { if (c === 9) score += 2; }
g2();
function g3({ w: [a, b, [c] = [5]] } = { w: [7, 8] }) { if (c === 5) score += 4; }
g3();
function g4({ w: [a, b, { c } = { c: 3 }] } = { w: [7, 8] }) { if (c === 3) score += 8; }
g4();
function g5({ w: [a, b, [c]] } = { w: [7, 8] }) {}
try { g5(); } catch (e) { if (e instanceof TypeError) score += 16; }
function g6({ w: [a, b, c] = [4, 5, 6] } = { w: [7, 8] }) { if (a === 7 && b === 8) score += 32; }
g6({ w: [7, 8] });
export function test() { return score; }`;

describe("#6651 C4 — array patterns over a tuple-struct source", () => {
  it("an `undefined` tuple element binds as undefined, not NaN (standalone)", async () => {
    // Base: 7 (= 1+2+4) — `String(y)` read "NaN" (the `=== undefined` and
    // `typeof` observers still matched the sentinel), and `z` was null.
    expect(await runJsStandalone(PROP_ARY)).toBe(63);
  });

  it("an `undefined` tuple element binds as undefined, not NaN (host)", async () => {
    // Base: 1 — on the host lane every observer of `y` saw the NUMBER NaN.
    expect(await runJsHost(PROP_ARY)).toBe(63);
  });

  it("elements past the end of the tuple read undefined and run their own defaults (standalone)", async () => {
    // Base: 32 — `c` stayed null, no element default fired, `[c]` of the
    // missing element did not throw.
    expect(await runJsStandalone(EXHAUSTED)).toBe(63);
  });

  it("elements past the end of the tuple read undefined and run their own defaults (host)", async () => {
    expect(await runJsHost(EXHAUSTED)).toBe(63);
  });
});
