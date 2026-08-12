// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3471 — host-lane: a polymorphic helper's `any` parameter was unsoundly
// narrowed to f64 by the body-usage fallback, corrupting comparisons.
//
// Root cause (NOT the try/catch the issue first suspected — see the issue file
// "Handoff" trail): `inferParamTypeFromBody` (param-return-inference.ts) narrows
// an untyped parameter to f64 on a SINGLE numeric body use (`1 / a`). It was run
// as a fallback whenever `inferParamTypeFromCallSites` returned null — but null
// covers BOTH "no call sites" (an exported/host-only entrypoint, where the body
// is the only signal — sound) AND "called internally with `any`/polymorphic
// args" (UNSOUND: a single numeric use does not prove the param is always a
// number). test262's `isSameValue(a, b)` — `if (a === 0 …) return 1/a === 1/b;
// if (a !== a && b !== b) return true; return a === b;` — is exactly the second
// case: it does `1/a` but is called with strings/objects. It was compiled with
// `(param f64 f64)`, so a string arg coerced to NaN at the call boundary and
// `a !== a && b !== b` became `true && true` → `isSameValue("x","y") === true`.
// That is what made `propertyHelper.js`'s `isWritable` mis-classify a failed
// non-writable write as "succeeded", run its revert (a SECOND strict write),
// and throw an uncaught TypeError — the ~433 `built-ins/**/name.js` /
// `length.js` conformance failures.
//
// Fix: gate the body-usage fallback on `!sawCallSite` — only trust body usage
// for a genuinely-uncalled function. A polymorphic helper (has call sites, all
// `any`) keeps its boxed `externref` params, so non-number args survive.

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { describe, expect, it } from "vitest";

/** Compile in host mode, instantiate, and return the exported `test()` value. */
async function runTest(src: string): Promise<unknown> {
  const r = await compile(src, { fileName: "t.ts" });
  expect(r.success, r.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  const imports = buildImports(r.imports, {}, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports as WebAssembly.Imports);
  const exports = instance.exports as Record<string, (...a: unknown[]) => unknown>;
  if ((imports as { setExports?: (e: unknown) => void }).setExports) {
    (imports as { setExports: (e: unknown) => void }).setExports(exports);
  }
  return exports.test();
}

/** The `(param …)` signature string of `func`, or `""` if it uses a shared type. */
async function paramSig(src: string, func: string): Promise<string> {
  const r = await compile(src, { fileName: "t.ts", emitWat: true });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const wat = r.wat ?? "";
  const m = wat.match(new RegExp(`\\(func \\$${func} \\(param ([^)]*)\\)`));
  return m ? m[1]! : "";
}

// The SameValue comparator shape from test262's propertyHelper.js, verbatim in
// its numeric-flow structure. Its params are untyped (`any`).
const SAME_VALUE = `
function isSameValue(a, b) {
  if (a === 0 && b === 0) return 1 / a === 1 / b;
  if (a !== a && b !== b) return true;
  return a === b;
}`;

describe("#3471 — polymorphic comparator param must not be narrowed to f64", () => {
  it("isSameValue called with any-typed STRING args compares by value (regression: returned true)", async () => {
    // `check`'s params are `any`, so `isSameValue(obj[key], val)` passes
    // `any`-typed args — the exact call shape that made call-site inference
    // return null and (pre-fix) trigger the unsound body fallback.
    const src = `${SAME_VALUE}
      function check(obj, key, val) { return isSameValue(obj[key], val); }
      export function test() {
        var o = { name: "slice" };
        return check(o, "name", "unlikelyValue") ? 1 : 0;
      }`;
    // "slice" !== "unlikelyValue" → isSameValue must be false → 0.
    // Pre-fix this returned 1 (both strings coerced to NaN, NaN!==NaN true).
    expect(await runTest(src)).toBe(0);
  });

  it("isSameValue of two DIFFERENT any-typed strings is false; equal strings true", async () => {
    const src = `${SAME_VALUE}
      function check(obj, k1, k2) { return isSameValue(obj[k1], obj[k2]); }
      export function test() {
        var o = { a: "foo", b: "bar", c: "foo" };
        var diff = check(o, "a", "b") ? 1 : 0;   // "foo" vs "bar" → 0
        var same = check(o, "a", "c") ? 10 : 0;  // "foo" vs "foo" → 10
        return diff + same;                      // expect 10
      }`;
    expect(await runTest(src)).toBe(10);
  });

  it("isSameValue with any-typed args keeps boxed (externref) params, not f64", async () => {
    const src = `${SAME_VALUE}
      function check(obj, key, val) { return isSameValue(obj[key], val); }
      export function test() { var o = { name: "x" }; return check(o, "name", "y") ? 1 : 0; }`;
    // The keystone of the fix: the comparator must NOT be `(param f64 f64)`.
    expect(await paramSig(src, "isSameValue")).not.toMatch(/f64/);
  });

  it("numeric args to isSameValue still compare correctly (no over-fix)", async () => {
    const src = `${SAME_VALUE}
      function check(a, b) { return isSameValue(a, b); }
      export function test() {
        var eq = check(1, 1) ? 1 : 0;    // 1
        var ne = check(1, 2) ? 10 : 0;   // 0
        return eq + ne;                  // expect 1
      }`;
    expect(await runTest(src)).toBe(1);
  });
});

describe("#3471 — numeric-kernel param inference is NOT regressed", () => {
  it("an explicit JSDoc {*} parameter remains polymorphic when called across a module boundary", async () => {
    const src = `
      /** @param {*} value */
      export function baseToString(value) {
        if (typeof value == "string") return value;
        var result = value + "";
        return result == "0" && 1 / value == -Infinity ? "-0" : result;
      }
    `;
    const r = await compile(src, { fileName: "lodash-base-to-string.js", allowJs: true });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(r.wat ?? "").not.toMatch(/\(func \$baseToString \(param f64\)/);
    const imports = buildImports(r.imports, {}, r.stringPool);
    const { instance } = await WebAssembly.instantiate(r.binary, imports as WebAssembly.Imports);
    expect((instance.exports.baseToString as (value: string) => string)("Foo")).toBe("Foo");
  });

  it("a recursive numeric kernel still narrows its param to f64", async () => {
    // fact(n) is called internally as fact(n-1) with a number-typed arg, so
    // call-site inference (not the body fallback) supplies f64. Must stay f64.
    const src = `export function fact(n) { return n <= 1 ? 1 : n * fact(n - 1); }
      export function test() { return fact(5); }`;
    expect(await paramSig(src, "fact")).toBe("f64");
    expect(await runTest(src)).toBe(120);
  });

  it("an exported host-only numeric entrypoint (zero call sites) still narrows to f64", async () => {
    // No internal call site → the body fallback legitimately applies.
    const src = `export function dbl(x) { return x * 2; }
      export function test() { return 0; }`;
    expect(await paramSig(src, "dbl")).toBe("f64");
  });
});

describe("#3471 — isWritable-shape false-positive revert is fixed", () => {
  it("a failed non-writable-style compare does not spuriously report success", async () => {
    // Mirrors propertyHelper.js's isWritable: after a write that leaves the old
    // value in place, `isSameValue(current, newValue)` must be false so the
    // revert branch is NOT entered. Pre-fix, isSameValue's NaN-coercion made it
    // true, entering the revert (which in the real harness threw uncaught).
    const src = `${SAME_VALUE}
      function isWritableLike(obj, name, newValue) {
        var oldValue = obj[name];
        // (write elided — the property is non-writable so it stays oldValue)
        var writeSucceeded = isSameValue(obj[name], newValue);
        if (writeSucceeded) { return 999; } // revert branch — must NOT run
        return oldValue === "slice" ? 0 : -1;
      }
      export function test() {
        var o = { name: "slice" };
        return isWritableLike(o, "name", "unlikelyValue");
      }`;
    expect(await runTest(src)).toBe(0);
  });
});
