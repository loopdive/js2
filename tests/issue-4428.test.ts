// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4428) `new Array(<wrapper>)` element identity across a REBOUND `var`.
//
// What actually broke, and why the obvious suspects are innocent
// --------------------------------------------------------------
// `new Boolean(false)` builds a genuine distinct object (two of them compare
// `!==`, `typeof` is `"object"`), and #4426's one-element `new Array(<non-number>)`
// path stores it into a `$__vec_externref` with identity intact. Both were
// measured in isolation and both are fine.
//
// The loss is in the SLOT. test262 S15.4.2.2_A2.3_T2 writes the same `var` twice:
//
//   var x = new Array(true);        // checker: boolean[] → an i32-element vec
//   var obj = new Boolean(false);
//   var x = new Array(obj);         // an externref-element vec …
//
// TypeScript keeps declaration #1's type for the redeclared `var` in a `.js`
// source, so the second store is a vec→vec coercion that copies element-wise
// through `ToNumber` — the wrapper arrives as i32 `0`. `_T4`/`_T5` passed only
// because they have no primitive-array predecessor to pin the slot.
//
// Each identity assertion below is paired with a check that the element is an
// OBJECT (`typeof`, and a cross-comparison against a second distinct wrapper).
// Without that, a build that collapsed every wrapper to one shared value — or
// to `null` — would satisfy `x[0] === obj` vacuously.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { runTest262File } from "./test262-runner.js";

const OPTS = {
  target: "standalone",
  allowJs: true,
  skipSemanticDiagnostics: true,
  deferTopLevelInit: true,
  hostBridge: "always",
  fileName: "issue-4428.js",
} as const;

async function runJs(source: string): Promise<number> {
  const r = await compile(source, OPTS);
  expect(r.success, r.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  const exports = instance.exports as Record<string, () => number>;
  if (typeof exports.__module_init === "function") exports.__module_init();
  return exports.test!();
}

describe("#4428 — array element identity survives a rebound var", () => {
  it("Boolean wrapper: x[0] === obj after a primitive-array predecessor", async () => {
    expect(
      await runJs(`var x = new Array(true);
var obj = new Boolean(false);
var x = new Array(obj);
var ok = (x[0] === obj) ? 1 : 0;
export function test() { return ok; }`),
    ).toBe(1);
  });

  it("String wrapper: x[0] === obj after a primitive-array predecessor", async () => {
    expect(
      await runJs(`var x = new Array("1");
var obj = new String("0");
var x = new Array(obj);
var ok = (x[0] === obj) ? 1 : 0;
export function test() { return ok; }`),
    ).toBe(1);
  });

  it("the stored element is an OBJECT, not a re-boxed primitive", async () => {
    // Cross check: a second, distinct wrapper of the SAME value must NOT match,
    // so `x[0] === obj` cannot be passing because everything collapsed to one
    // shared boxed `false`.
    expect(
      await runJs(`var x = new Array(true);
var obj = new Boolean(false);
var other = new Boolean(false);
var x = new Array(obj);
var isObject = (typeof x[0] === "object") ? 1 : 0;
var notOther = (x[0] === other) ? 0 : 1;
export function test() { return isObject + notOther; }`),
    ).toBe(2);
  });

  it("length still reads 1 — the slot stays a vec, only its ELEMENT widens", async () => {
    // A boxed-externref carrier (the other candidate widening) preserves the
    // element identity and breaks `.length`. This assertion is what rules it out.
    expect(
      await runJs(`var x = new Array(true);
var obj = new Boolean(false);
var x = new Array(obj);
var ok = (x.length === 1) ? 1 : 0;
export function test() { return ok; }`),
    ).toBe(1);
  });

  it("plain assignment (no redeclaration) widens too", async () => {
    expect(
      await runJs(`var obj = new Boolean(false);
var x = new Array(true);
x = new Array(obj);
var ok = (x[0] === obj) ? 1 : 0;
export function test() { return ok; }`),
    ).toBe(1);
  });

  it("array literals take the same widening", async () => {
    expect(
      await runJs(`var x = [true];
var obj = new Boolean(false);
var x = [obj];
var ok = (x[0] === obj) ? 1 : 0;
export function test() { return ok; }`),
    ).toBe(1);
  });

  it("a homogeneous primitive array is NOT widened — the predicate needs both domains", async () => {
    // Guards the narrowness of the analysis: without a proven object-element
    // write the slot must keep its element type, so the boolean reads back as a
    // boolean and `x[0] === 1` stays false (no numeric re-box).
    expect(
      await runJs(`var x = new Array(true);
var x = new Array(false);
var ok = (x[0] === false && x.length === 1) ? 1 : 0;
export function test() { return ok; }`),
    ).toBe(1);
  });
});

const HARNESS = join(__dirname, "..", "test262", "harness", "assert.js");
const TEST262 = existsSync(HARNESS);

describe.skipIf(!TEST262)("#4428 — test262 files", () => {
  // T2/T3 flip with this fix; T1/T4/T5 were already passing and must stay so —
  // they are the control that the widening did not disturb the ordinary lanes.
  const files = [
    "built-ins/Array/length/S15.4.2.2_A2.3_T1.js",
    "built-ins/Array/length/S15.4.2.2_A2.3_T2.js",
    "built-ins/Array/length/S15.4.2.2_A2.3_T3.js",
    "built-ins/Array/length/S15.4.2.2_A2.3_T4.js",
    "built-ins/Array/length/S15.4.2.2_A2.3_T5.js",
  ];
  for (const rel of files) {
    it(`${rel} passes on the standalone lane`, { timeout: 60_000 }, async () => {
      const abs = join(__dirname, "..", "test262", "test", rel);
      const r = await runTest262File(abs, "issue-4428", 30_000, "standalone");
      expect(`${r.status}: ${r.reason ?? ""}`).toBe("pass: ");
    });
  }
});
