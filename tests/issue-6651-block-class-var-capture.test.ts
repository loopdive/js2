// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#6651 cluster C, C2-b) A class declared inside a BLOCK whose method writes a
// captured function-scoped `var` dropped the write.
//
// `collectBlockScopedDeclNames` (`declarations.ts`) collected only `let` /
// `const`, on the premise that "a `var` is function-scoped and therefore
// already a module global". That is true at MODULE scope — and this function is
// only ever called from INSIDE a function body, which is exactly where it is
// false. A `var` declared in a function is an ordinary local, so the #2818
// capture-deferral never fired for it: the class compiled eagerly,
// `promoteAccessorCapturesToGlobals` never ran, and the method body wrote a
// FRESH local of the same name that nothing ever reads.
//
// Measured, standalone: the block form answered 0 where node answers 5, while
// the same class at function-body level (always deferred) answered 5; and the
// same shape with `let` instead of `var` already worked. Three closure kinds in
// one block discriminate it — a function expression and an object-literal
// method both landed, only the class method did not.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(source: string): Promise<number> {
  const result = await compile(source, { target: "standalone", skipSemanticDiagnostics: true });
  expect((result.errors ?? []).filter((e) => e.severity !== "warning")).toEqual([]);
  expect(result.imports ?? []).toEqual([]);
  const instance = await WebAssembly.instantiate(result.binary!, {});
  const exports = instance.instance.exports as { test?: () => number };
  expect(typeof exports.test).toBe("function");
  return exports.test!();
}

describe("#6651 cluster C2-b — block-scoped class capturing a function-scoped `var`", () => {
  it("a block-scoped class method writes the captured `var`", async () => {
    // base 0, node 5.
    expect(
      await runStandalone(`
export function test(): number {
  var n = 0;
  if (1) {
    class C { m() { n = 5; } }
    new C().m();
  }
  return n;
}`),
    ).toBe(5);
  });

  it("the class method is the only one of three closure kinds that was broken", async () => {
    // base 5 (function expression = 1 and object method = 4 already landed;
    // the class method's 2 was missing), node 7.
    expect(
      await runStandalone(`
export function test(): number {
  var a: string | undefined = undefined;
  var b: string | undefined = undefined;
  var c: string | undefined = undefined;
  try {
    const f = function () { a = "a"; };
    f();
    class C { method() { b = "b"; } }
    new C().method();
    const o = { m() { c = "c"; } };
    o.m();
  } catch (e) {}
  return (a === "a" ? 1 : 0) + (b === "b" ? 2 : 0) + (c === "c" ? 4 : 0);
}`),
    ).toBe(7);
  });

  it("the `let` form and the function-body form still work", async () => {
    // Regression guard: green on both sides — `let` was already deferred, and a
    // class at function-body level is deferred unconditionally.
    expect(
      await runStandalone(`
export function test(): number {
  let l = 0;
  if (1) {
    class A { m() { l = 1; } }
    new A().m();
  }
  var f = 0;
  class B { m() { f = 2; } }
  new B().m();
  return l + f;
}`),
    ).toBe(3);
  });
});
