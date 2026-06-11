// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1992 — `<value> instanceof Function` was hard-coded false for a compiled
// closure.
//
// A compiled closure is a WasmGC struct, so when `f instanceof Function`
// reaches the host `__instanceof(v, "Function")` runtime handler, V8's
// `v instanceof Function` is false for the opaque externref and the handler
// returned 0. Fix: the handler recognises a callable closure struct via
// `__is_closure` (the same discriminator `__typeof` uses to report
// "function") for the `Function` RHS, so an `any`-typed callable answers
// `true`. Non-callables (objects / strings / numbers) stay false; `instanceof
// Object` and user-class `instanceof` are unchanged.

import { describe, expect, it } from "vitest";

import { compileAndInstantiate } from "../src/runtime.js";

async function instanceofTest(body: string): Promise<boolean> {
  const exports = (await compileAndInstantiate(`export function test(): boolean { ${body} }`)) as { test(): number };
  // The exported boolean lowers to an i32 (1/0) at the JS boundary.
  return Boolean(exports.test());
}

describe("#1992 instanceof Function recognises compiled closures", () => {
  it("an arrow function is instanceof Function", async () => {
    expect(await instanceofTest("const f: any = () => 1; return f instanceof Function;")).toBe(true);
  });

  it("a function declaration value is instanceof Function", async () => {
    expect(await instanceofTest("function g() { return 1; } const f: any = g; return f instanceof Function;")).toBe(
      true,
    );
  });

  it("a closure is also instanceof Object (prototype chain)", async () => {
    expect(await instanceofTest("const f: any = () => 1; return f instanceof Object;")).toBe(true);
  });

  it("a plain object is NOT instanceof Function", async () => {
    expect(await instanceofTest("const o: any = { a: 1 }; return o instanceof Function;")).toBe(false);
  });

  it("primitives (number / string) are NOT instanceof Function", async () => {
    expect(await instanceofTest("const n: any = 5; return n instanceof Function;")).toBe(false);
    expect(await instanceofTest('const s: any = "x"; return s instanceof Function;')).toBe(false);
  });

  it("user-class instanceof is unchanged", async () => {
    expect(await instanceofTest("class A {} const a: any = new A(); return a instanceof A;")).toBe(true);
    expect(await instanceofTest("class A {} class B {} const a: any = new A(); return a instanceof B;")).toBe(false);
  });
});
