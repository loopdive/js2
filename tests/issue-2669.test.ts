// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

/**
 * #2669 — ES2015 destructuring correctness residual (nested-array default).
 *
 * Three distinct codegen defects in the array-destructuring default-init family,
 * all surfaced by the `dstr` test262 cluster (`*-ary-ptrn-elem-ary-elem-init`,
 * `for-of/dstr` default-init) and the umbrella's verify-first sweep:
 *
 *   - Bug 0 (malformed Wasm): a `ref_*` keyed vec (nested arrays/objects, e.g.
 *     `number[][]`) lowers its backing store to `(array (mut externref))`, so its
 *     elements are already externref. The element-conversion loop in
 *     `destructureParamArray` (and the host-boundary `__vec_get` helper) keyed off
 *     the `"ref_*"` STRING and emitted `extern.convert_any` — whose operand must be
 *     an `anyref` — on an externref `array.get`. Invalid Wasm ⇒ the module failed to
 *     instantiate (`const [[x,y,z]=[4,5,6]] = []`).
 *   - Bug 1 (for-of identifier default never fired): a for-of element with a
 *     default over an externref source was coerced to the (numeric) binding type
 *     BEFORE the default check, unboxing `undefined` to a plain NaN that never
 *     matched the f64 sNaN sentinel the check looks for (`for (const [a=9] of [[]])`
 *     kept NaN).
 *   - Bug 2 (for-of nested default ignored): the for-of nested-pattern branch
 *     dropped `element.initializer` entirely, so a short/empty source left the
 *     nested slot null and the recursive destructure threw
 *     "Cannot destructure 'null' or 'undefined'"
 *     (`for (const [[x,y,z]=[4,5,6]] of [[]])`).
 *
 * The closure-capture-box surface of this umbrella was fixed separately by #2692.
 */

async function compileAndRun(source: string): Promise<Record<string, Function>> {
  const result = await compile(source);
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as unknown as WebAssembly.Imports);
  return instance.exports as Record<string, Function>;
}

describe("#2669 — nested-array destructuring default (Bug 0: malformed Wasm)", () => {
  it("direct: nested array default fires when outer source is empty", async () => {
    const e = await compileAndRun(
      `export function test(): number { const [[x, y, z] = [4, 5, 6]]: number[][] = []; return x + y + z; }`,
    );
    expect(e.test!()).toBe(15);
  });

  it("direct: nested array default, single element", async () => {
    const e = await compileAndRun(`export function test(): number { const [[x] = [4]]: number[][] = []; return x; }`);
    expect(e.test!()).toBe(4);
  });

  it("direct: nested array default SKIPPED when element present", async () => {
    const e = await compileAndRun(
      `export function test(): number { const [[x, y, z] = [4, 5, 6]]: number[][] = [[1, 2, 3]]; return x + y + z; }`,
    );
    expect(e.test!()).toBe(6);
  });

  it("direct: nested array NO default, value present (regression guard)", async () => {
    const e = await compileAndRun(
      `export function test(): number { const [[x, y, z]]: number[][] = [[1, 2, 3]]; return x + y + z; }`,
    );
    expect(e.test!()).toBe(6);
  });
});

describe("#2669 — for-of destructuring default (Bug 1: identifier default)", () => {
  it("for-of simple default fires when iterated element is empty", async () => {
    const e = await compileAndRun(
      `export function test(): number { let s = -1; for (const [a = 9] of [[]]) { s = a; } return s; }`,
    );
    expect(e.test!()).toBe(9);
  });

  it("for-of simple default SKIPPED when element present (regression guard)", async () => {
    const e = await compileAndRun(
      `export function test(): number { let s = -1; for (const [a = 9] of [[5]]) { s = a; } return s; }`,
    );
    expect(e.test!()).toBe(5);
  });
});

describe("#2669 — for-of nested destructuring default (Bug 2: nested default ignored)", () => {
  it("for-of nested array default fires when iterated element is empty", async () => {
    const e = await compileAndRun(
      `export function test(): number { let s = 0; for (const [[x, y, z] = [4, 5, 6]] of [[]]) { s = x + y + z; } return s; }`,
    );
    expect(e.test!()).toBe(15);
  });

  it("for-of nested array default, single element", async () => {
    const e = await compileAndRun(
      `export function test(): number { let s = -1; for (const [[x] = [4]] of [[]]) { s = x; } return s; }`,
    );
    expect(e.test!()).toBe(4);
  });

  it("for-of nested array NO default, value present (regression guard)", async () => {
    const e = await compileAndRun(
      `export function test(): number { let s = 0; for (const [[x, y, z]] of [[[1, 2, 3]]]) { s = x + y + z; } return s; }`,
    );
    expect(e.test!()).toBe(6);
  });

  // (#2669 CI-FIX) A CALL-expression nested default (capturing helper / generator
  // / IIFE) is deliberately DEFERRED: compiling it inside the conditionally-skipped
  // default arm materialised its capture box only on the not-taken branch and
  // corrupted later reads of the captured variable (#2692 closure-box-lazy
  // territory; also #2566 generator over-consumption). This regressed 15
  // `for-await-of` elision-default tests in the merge_group floor. The deferral
  // keeps the captured variable intact when the element is PRESENT — h() must not
  // run AND `count` must read its real value (0), not a poisoned NaN.
  it("for-of nested call-default does not poison a captured var when element present", async () => {
    const e = await compileAndRun(`export function test(): number {
      let count = 0;
      function h(): number[] { count += 1; return [9]; }
      let s = -1;
      for (const [[x] = h()] of [[[5]]]) { s = x; }  // element present → x = 5, h() never runs
      return count * 100 + s;                         // expect 0*100 + 5 = 5
    }`);
    expect(e.test!()).toBe(5);
  });
});

// ── Slice: typed in-bounds `undefined` / hole default-init (this slice) ──────────
//
// Bug 3 (typed in-bounds sentinel-propagation): an array whose element type is
// EXACTLY the `undefined` (or `void`) primitive — `[[undefined]]` (TS infers
// `undefined[][]`) or a hole-only literal `[[,]]` — resolved its element type to
// i32 via `mapTsTypeToWasm`, storing `undefined` as i32 `0`. The for-of array
// path then coerced that i32 `0` to f64 `0.0`, which never matched the f64 sNaN
// sentinel the default-check looks for, so the default `[x = 23]` never fired
// (`for (const [x = 23] of [[undefined]])` / `[[,]]` left x = 0). Distinct from
// the externref/OOB Bug 1 above: here the element is IN BOUNDS and present as a
// literal `undefined`/hole. Fix: widen an exactly-`undefined`/`void` vec element
// type to externref in `resolveWasmType` (mirrors the #1468 struct-field widening)
// so the `__get_undefined()` / `__extern_is_undefined` sentinel path preserves it.
// Real test262: language/statements/for-of/dstr/{const,let,var}-ary-ptrn-elem-id-init-{undef,hole}.js
describe("#2669 — typed in-bounds undefined/hole default-init (Bug 3)", () => {
  it("for-of: default fires for an in-bounds explicit `undefined` element", async () => {
    const e = await compileAndRun(`export function test(): number {
      let out = 0;
      for (let [x = 23] of [[undefined]]) { out = x; }
      return out;
    }`);
    expect(e.test!()).toBe(23);
  });

  it("for-of: default fires for an in-bounds elision hole", async () => {
    const e = await compileAndRun(`export function test(): number {
      let out = 0;
      for (let [x = 23] of [[,]]) { out = x; }
      return out;
    }`);
    expect(e.test!()).toBe(23);
  });

  it("for-of: default SKIPPED when the element is present (regression guard)", async () => {
    const e = await compileAndRun(`export function test(): number {
      let out = 0;
      for (let [x = 23] of [[7]]) { out = x; }
      return out;
    }`);
    expect(e.test!()).toBe(7);
  });

  it("for-of: const/explicit-undefined matches the const-ary-ptrn-elem-id-init-undef shape", async () => {
    const e = await compileAndRun(`export function test(): number {
      let iterCount = 0;
      let val = -1;
      for (const [x = 23] of [[undefined]]) { val = x; iterCount += 1; }
      return iterCount * 100 + val;   // expect 1*100 + 23 = 123
    }`);
    expect(e.test!()).toBe(123);
  });
});
