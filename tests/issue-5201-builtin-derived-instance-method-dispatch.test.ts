// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #5201 — a USER-DEFINED instance method of a builtin-derived class
// (`class D extends Array`) was lost the moment the instance passed through a
// binding declared with the class's own type, so a later call on an
// imprecisely-typed receiver reported `<method> is not a function`.
//
// ROOT CAUSE (measured, not inferred). `resolveWasmType` decided the Wasm
// representation of `D` from the ARRAY arm — `inheritedArrayElementType`
// matches any type that inherits an array element type, `class D extends
// Array` included — and answered `ref_null $__vec_externref`. But
// `new D()` returns an EXTERNREF: `<Class>_new` builds a host object and
// installs `D.prototype` on it, which is where `m` lives. So `const d = new
// D()` hit the generic externref→vec marshalling and MATERIALIZED A FRESH VEC
// by copying elements — dropping object identity and the entire method table.
// Re-entering the host, that vec is an opaque WasmGC struct, and
// `__extern_method_call` could not find `m` on it.
//
// The #1366a rule that would have prevented this ("an externref-backed user
// class is externref") already existed — but at the named-struct lookup, ~380
// lines BELOW the array arm, so a builtin-derived class never reached it. The
// fix hoists that check above every structural / intrinsic-spelling arm.
//
// WHY THE OBVIOUS REPRO DOES NOT REPRODUCE, and what the "something extra"
// was: `f(new D())` is fine on base — the constructor's externref never meets
// a `D`-typed slot, so nothing materializes. The defect needs the value to
// pass through a DECLARED BINDING of the class's own type first. That is why
// `class C extends Array { m(){return 1} } new C().m()` looked healthy while
// jsbi's `const _ = …; _.__clzmsd()` did not. The `A …, arg=new` case below is
// kept as the control that pins this asymmetry.
//
// Real-world shape: jsbi@4.3.0 declares `__clzmsd()` on `class JSBI extends
// Array` and calls it as `_.__clzmsd()` from `static multiply(_, t)` /
// `static __absoluteAdd(_, t, e)`, at @js-temporal/polyfill module-init time.
// Third blocker in the #4628 Option A chain (#5191 → #5193 → this).
//
// STANDALONE: the `any`-receiver cases below are HOST-ONLY on purpose. Under
// `--target standalone` a dynamic member call on ANY externref-backed
// builtin-derived instance (`extends Object` / `Error` / `Array`, and equally
// with `arg=new`) fails to find user methods — measured identical before and
// after this fix, so it is a separate, family-wide standalone dynamic-dispatch
// gap, not this defect. The standalone lane below pins the shapes that do work
// so the fix is shown not to disturb them.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { compileToWasm } from "./equivalence/helpers.js";

async function runStandalone(source: string): Promise<number> {
  const result = await compile(source, { target: "standalone", fileName: "issue-5201.ts" });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary), "module failed WebAssembly.validate").toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { test: () => number }).test();
}

async function runHost(source: string): Promise<number> {
  const exports = await compileToWasm(source);
  return exports.test!() as number;
}

const DECL = `class D extends Array { m(): number { return 7; } }`;

describe("#5201 user method of a builtin-derived class, imprecise receiver", () => {
  it("free function, receiver via a D-typed local (the reduced repro — throws on base)", async () => {
    await expect(
      runHost(`${DECL}
function f(a: any): number { return a.m(); }
export function test(): number { const d = new D(); return f(d); }`),
    ).resolves.toBe(7);
  });

  it("static method of the class itself, receiver via a D-typed local (jsbi's exact shape)", async () => {
    // `static multiply(_, t) { … _.__clzmsd() … }` — a static of the SAME
    // builtin-derived class, receiver reached through a declared binding.
    await expect(
      runHost(`class D extends Array {
  __clzmsd(): number { return 7; }
  static mul(a: any): number { return a.__clzmsd(); }
}
export function test(): number { const d = new D(); return D.mul(d); }`),
    ).resolves.toBe(7);
  });

  it("instance method calling through a `this`-alias (jsbi's `const _ = this` convention)", async () => {
    await expect(
      runHost(`class D extends Array {
  __clzmsd(): number { return 7; }
  outer(): number { const _: any = this; return _.__clzmsd(); }
}
export function test(): number { const d = new D(); return d.outer(); }`),
    ).resolves.toBe(7);
  });

  it("static method of an UNRELATED class, receiver via a D-typed local", async () => {
    await expect(
      runHost(`${DECL}
class O { static f(a: any): number { return a.m(); } }
export function test(): number { const d = new D(); return O.f(d); }`),
    ).resolves.toBe(7);
  });

  it("control: receiver passed straight from `new D()` already worked on base", async () => {
    await expect(
      runHost(`${DECL}
function f(a: any): number { return a.m(); }
export function test(): number { return f(new D()); }`),
    ).resolves.toBe(7);
  });

  it("control: a plain (non-derived) class was never affected", async () => {
    await expect(
      runHost(`class P { m(): number { return 7; } }
function f(a: any): number { return a.m(); }
export function test(): number { const p = new P(); return f(p); }`),
    ).resolves.toBe(7);
  });
});

describe("#5201 genuinely-builtin methods keep their fast path", () => {
  it("push/length on a D-typed local (host)", async () => {
    await expect(
      runHost(`${DECL}
export function test(): number { const d = new D(); d.push(1); d.push(2); return d.length; }`),
    ).resolves.toBe(2);
  });

  it("push/length on a D-typed local (standalone)", async () => {
    await expect(
      runStandalone(`${DECL}
export function test(): number { const d = new D(); d.push(1); d.push(2); return d.length; }`),
    ).resolves.toBe(2);
  });

  it("indexed read on a D-typed local (host)", async () => {
    await expect(
      runHost(`${DECL}
export function test(): number { const d = new D(); d.push(5); return d[0] as number; }`),
    ).resolves.toBe(5);
  });

  it("slice on a D-typed local (host)", async () => {
    await expect(
      runHost(`${DECL}
export function test(): number { const d = new D(); d.push(1); d.push(2); return d.slice(1).length; }`),
    ).resolves.toBe(1);
  });

  it("for-of over a D-typed local (host)", async () => {
    await expect(
      runHost(`${DECL}
export function test(): number { const d = new D(); d.push(4); d.push(6); let s = 0; for (const x of d) s += x as number; return s; }`),
    ).resolves.toBe(10);
  });

  it("`instanceof Array` and `instanceof D` still hold (host)", async () => {
    await expect(
      runHost(`${DECL}
export function test(): number { const d = new D(); return (d instanceof Array ? 1 : 0) + (d instanceof D ? 2 : 0); }`),
    ).resolves.toBe(3);
  });

  it("a statically-typed receiver dispatches to the compiled method (host)", async () => {
    await expect(
      runHost(`${DECL}
function g(d: D): number { return d.m(); }
export function test(): number { const d = new D(); return g(d); }`),
    ).resolves.toBe(7);
  });

  it("a statically-typed receiver dispatches to the compiled method (standalone)", async () => {
    await expect(
      runStandalone(`${DECL}
function g(d: D): number { return d.m(); }
export function test(): number { const d = new D(); return g(d); }`),
    ).resolves.toBe(7);
  });

  it("Error and Map subclasses keep their own methods (host)", async () => {
    await expect(
      runHost(`class E extends Error { code(): number { return 9; } }
export function test(): number { const e = new E("x"); return e.code(); }`),
    ).resolves.toBe(9);
    await expect(
      runHost(`class M extends Map<string, number> { two(): number { return 2; } }
export function test(): number { const m = new M(); m.set("a", 1); return m.get("a")! + m.two(); }`),
    ).resolves.toBe(3);
  });

  it("a plain array is untouched (host)", async () => {
    await expect(
      runHost(`export function test(): number { const a: number[] = []; a.push(1); a.push(2); return a.length; }`),
    ).resolves.toBe(2);
  });
});
