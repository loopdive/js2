// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1682 — derived-constructor super-must-be-called for builtin subclasses.
//
// A derived class constructor that never calls `super(...)` leaves the `this`
// binding uninitialized. Per ECMA-262 §10.2.2 (ConstructorEvaluation) the
// constructor's GetThisBinding throws a ReferenceError on return. We previously
// ran the (super-less) constructor body and returned the un-super'd instance,
// so `new Sub()` silently succeeded. The fix emits the spec ReferenceError when
// a derived constructor statically contains no `super(...)` call.

import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function run(src: string): Promise<unknown> {
  const r = await compile(src, { fileName: "test.ts" });
  if (!r.success) throw new Error("compile error: " + r.errors?.[0]?.message);
  const { instance } = await WebAssembly.instantiate(r.binary, r.importObject);
  return (instance.exports as { test?: () => unknown }).test?.();
}

describe("#1682 derived constructor must call super() for builtin subclasses", () => {
  it("WeakMap subclass omitting super() throws ReferenceError", async () => {
    const src = `export function test(): number {
      class C extends WeakMap { constructor() {} }
      try { new C(); return 0; } catch (e) { return e instanceof ReferenceError ? 1 : 2; }
    }`;
    expect(await run(src)).toBe(1);
  });

  it("Promise subclass omitting super() throws ReferenceError", async () => {
    const src = `export function test(): number {
      class C extends Promise<number> { constructor() {} }
      try { new C(); return 0; } catch (e) { return e instanceof ReferenceError ? 1 : 2; }
    }`;
    expect(await run(src)).toBe(1);
  });

  it("Object subclass omitting super() throws ReferenceError", async () => {
    const src = `export function test(): number {
      class C extends Object { constructor() {} }
      try { new C(); return 0; } catch (e) { return e instanceof ReferenceError ? 1 : 2; }
    }`;
    expect(await run(src)).toBe(1);
  });

  it("constructor body with statements but no super() still throws", async () => {
    const src = `export function test(): number {
      class C extends WeakMap { constructor() { let a = 1; a = a + 1; } }
      try { new C(); return 0; } catch (e) { return e instanceof ReferenceError ? 1 : 2; }
    }`;
    expect(await run(src)).toBe(1);
  });

  it("calling super() constructs the instance without throwing", async () => {
    const src = `export function test(): number {
      class C extends WeakMap { constructor() { super(); } }
      try { const c = new C(); return c instanceof C ? 1 : 2; } catch (e) { return 3; }
    }`;
    expect(await run(src)).toBe(1);
  });
});
