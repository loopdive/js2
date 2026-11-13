// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1567 — "Builtin subclass proto splice leaks side effects" was filed as a
 * trio of test262 regressions blamed on PR #459 (`__set_subclass_proto`).
 *
 * Investigation finding: none of the three failing tests use `class extends`,
 * so `__set_subclass_proto` is never invoked for them. The two TypedArray
 * descriptor failures were caused by the test *harness*, not the runtime:
 * `wrapTest` injected `const TypedArray = Int8Array` as the stand-in for the
 * abstract `%TypedArray%` intrinsic. The `length`/`byteLength`/`buffer`/… getters
 * live on `%TypedArray%.prototype` and are *inherited* by `Int8Array.prototype`,
 * not own — so `Object.getOwnPropertyDescriptor(Int8Array.prototype, "length")`
 * returned `undefined`, failing every `built-ins/TypedArray/prototype/*`
 * descriptor test. The third (RegExp brand check) already passes on current main.
 *
 * Fix: bind `TypedArray` to the real `%TypedArray%` intrinsic, which on the host
 * is `Object.getPrototypeOf(Int8Array.prototype).constructor`. We route through
 * `Int8Array.prototype` (member access on a builtin, which the compiler resolves
 * to the host prototype) rather than the bare `Int8Array` identifier (which the
 * compiler does not evaluate as a first-class value).
 *
 * These tests lock both the harness shim and the underlying spec behaviours.
 */
import { describe, expect, it } from "vitest";
import { compileAndInstantiate } from "../src/runtime.js";
import { wrapTest } from "./test262-runner.js";

async function run(src: string): Promise<number> {
  const exports = await compileAndInstantiate(src);
  return ((exports as any).test as () => number)();
}

describe("#1567 — %TypedArray% intrinsic descriptor fidelity", () => {
  it("Object.getPrototypeOf(Int8Array.prototype) exposes the %TypedArray%.prototype length getter", async () => {
    // get %TypedArray%.prototype.length is an accessor whose getter Function
    // has .length === 0 (ES §17 built-in function length default).
    const src = `
export function test(): number {
  const taProto: any = Object.getPrototypeOf(Int8Array.prototype);
  const desc: any = Object.getOwnPropertyDescriptor(taProto, "length");
  if (desc == null) { return 10; }
  if (typeof desc.get !== "function") { return 11; }
  if (desc.get.length !== 0) { return 12; }
  return 1;
}`;
    expect(await run(src)).toBe(1);
  });

  it("end-to-end: the wrapped length.js descriptor query compiles and passes", async () => {
    // Render the test262 `TypedArray/prototype/length/length.js` body through
    // the real `wrapTest` pipeline, then compile + run it. With the abstract
    // `%TypedArray%` binding the `length` getter resolves; with the old
    // `Int8Array` binding `desc` was `undefined` and `desc.get` threw.
    const { source } = wrapTest(
      `/*---
includes: [propertyHelper.js, testTypedArray.js]
features: [TypedArray]
---*/
var desc = Object.getOwnPropertyDescriptor(TypedArray.prototype, "length");

verifyProperty(desc.get, "length", {
  value: 0,
  writable: false,
  enumerable: false,
  configurable: true
});
`,
      // Let wrapTest parse the frontmatter. An explicit `{}` meta has no
      // `includes`, so the propertyHelper.js shim (which rewrites
      // `verifyProperty(...)` into assertions) never ran and the call reached
      // the module as a free identifier, which now throws the spec
      // ReferenceError at run time ("verifyProperty is not defined").
    );
    expect(await run(source)).toBe(1);
  });

  it("wrapTest binds TypedArray to the abstract %TypedArray% intrinsic, not Int8Array", () => {
    const { source } = wrapTest(
      `/*---
includes: [propertyHelper.js, testTypedArray.js]
features: [TypedArray]
---*/
var desc = Object.getOwnPropertyDescriptor(TypedArray.prototype, "length");
`,
      {} as never,
    );
    // The injected binding must derive %TypedArray% from the prototype chain,
    // never bind the concrete Int8Array constructor directly.
    expect(source).toContain("Object.getPrototypeOf(Int8Array.prototype).constructor");
    expect(source).not.toContain("const TypedArray: any = Int8Array;");
  });
});

describe("#1567 — RegExp.prototype.test brand check (already-fixed, regression lock)", () => {
  it("RegExp.prototype.test called on a non-RegExp receiver throws TypeError", async () => {
    // S15.10.6.3_A2_T8: stamping RegExp.prototype.test onto a string receiver
    // must throw TypeError (the brand check rejects non-RegExp `this`).
    const src = `
export function test(): number {
  let threw: number = 0;
  let wasTypeError: number = 0;
  try {
    const t: any = (RegExp.prototype as any).test;
    t.call(".", "abc");
  } catch (e) {
    threw = 1;
    if (e instanceof TypeError) { wasTypeError = 1; }
  }
  if (!threw) { return 20; }
  if (!wasTypeError) { return 21; }
  return 1;
}`;
    expect(await run(src)).toBe(1);
  });
});
