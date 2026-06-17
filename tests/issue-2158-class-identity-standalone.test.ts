// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2158 — standalone class/prototype/descriptor conformance residual.
//
// Two host-free defects fixed here, both surfacing only in --target standalone
// (no JS host Proxy / host-eq import):
//
//  1. `.constructor` identity. `new A().constructor === A` and
//     `A.prototype.constructor`-shaped reads must be reference-identical to the
//     class value `A`. Previously instance `.constructor` lowered to a
//     `ref.func` + `extern.convert_any` (a funcref-as-externref) while the class
//     identifier `A` resolves to the `__class_<Name>` singleton struct, so the
//     two were never `===`. Both now resolve to the same `__class_<Name>`
//     singleton. (Architecture spec #2101 P1.)
//
//  2. Subclass identity / typeof in standalone. An EMPTY class root struct is
//     `(struct (field $__tag i32))`; the native-string supertype `$AnyString`
//     is also a single-i32-field open struct. WasmGC iso-recursive
//     canonicalization (#2009) merged the open class root with `$AnyString`,
//     so its `final` subclasses became subtypes of `$AnyString` and
//     `ref.test $AnyString` returned TRUE for a subclass instance. That false
//     positive drove the standalone `===` / `typeof` string arm into
//     `ref.cast $AnyString` + `__str_flatten` on a non-string struct →
//     `RuntimeError: illegal cast`, breaking every strict equality and string
//     typeof over a subclass value. A hidden sentinel field on empty class
//     roots makes them structurally distinct from `$AnyString`.
//
// Spec references:
// - ECMA-262 §10.2.4 (constructor [[Prototype]] / .constructor wiring)
// - ECMA-262 §7.2.16 IsStrictlyEqual (object identity by reference)
// - ECMA-262 §13.5.3 typeof
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<unknown> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => unknown }).test();
}

describe("#2158 standalone class constructor identity", () => {
  it("new A().constructor === A (base class)", async () => {
    expect(
      await runStandalone(`class A { m(){ return 1; } }
        export function test(): boolean { return new A().constructor === A; }`),
    ).toBe(1);
  });

  it("new A().constructor === A (class with fields)", async () => {
    expect(
      await runStandalone(`class A { x: number; constructor(){ this.x = 7; } }
        export function test(): boolean { return new A().constructor === A; }`),
    ).toBe(1);
  });

  it("new B().constructor === B (subclass)", async () => {
    expect(
      await runStandalone(`class A {} class B extends A {}
        export function test(): boolean { return new B().constructor === B; }`),
    ).toBe(1);
  });

  it("new B().constructor !== A (subclass ctor is not the parent)", async () => {
    expect(
      await runStandalone(`class A {} class B extends A {}
        export function test(): boolean { return new B().constructor === A; }`),
    ).toBe(0);
  });

  it(".constructor is stable across reads", async () => {
    expect(
      await runStandalone(`class A {}
        export function test(): boolean { const a = new A(); return a.constructor === a.constructor; }`),
    ).toBe(1);
  });
});

describe("#2158 standalone empty-subclass identity (AnyString canonicalization guard)", () => {
  it("empty subclass class-value identity (B === B)", async () => {
    expect(
      await runStandalone(`class A {} class B extends A {}
        export function test(): boolean { return B === B; }`),
    ).toBe(1);
  });

  it("empty subclass instance self-identity", async () => {
    expect(
      await runStandalone(`class A {} class B extends A {}
        export function test(): boolean { const x: any = new B(); return x === x; }`),
    ).toBe(1);
  });

  it("distinct empty-subclass instances are not ===", async () => {
    expect(
      await runStandalone(`class A {} class B extends A {}
        export function test(): boolean { const x: any = new B(); const y: any = new B(); return x === y; }`),
    ).toBe(0);
  });

  it("empty subclass instance is not typeof string", async () => {
    expect(
      await runStandalone(`class A {} class B extends A {}
        export function test(): boolean { const b: any = new B(); return typeof b === "string"; }`),
    ).toBe(0);
  });

  it("empty subclass instance is typeof object", async () => {
    expect(
      await runStandalone(`class A {} class B extends A {}
        export function test(): boolean { const b: any = new B(); return typeof b === "object"; }`),
    ).toBe(1);
  });
});

describe("#2158 no regression to existing class behaviour (standalone)", () => {
  it("instance method dispatch still works", async () => {
    expect(
      await runStandalone(`class A { x: number; constructor(){ this.x = 42; } g(){ return this.x; } }
        export function test(): number { return new A().g(); }`),
    ).toBe(42);
  });

  it("subclass field + inherited field via super()", async () => {
    expect(
      await runStandalone(`class A { a: number; constructor(){ this.a = 1; } }
        class B extends A { b: number; constructor(){ super(); this.b = 2; } g(){ return this.a + this.b; } }
        export function test(): number { return new B().g(); }`),
    ).toBe(3);
  });

  it("Object.getPrototypeOf(new A()) === A.prototype", async () => {
    expect(
      await runStandalone(`class A {}
        export function test(): boolean { return Object.getPrototypeOf(new A()) === A.prototype; }`),
    ).toBe(1);
  });

  it("instanceof across the empty hierarchy", async () => {
    expect(
      await runStandalone(`class A {} class B extends A {}
        export function test(): boolean { const b: any = new B(); return (b instanceof B) && (b instanceof A); }`),
    ).toBe(1);
  });

  it("native string equality is unaffected", async () => {
    expect(
      await runStandalone(
        `export function test(): boolean { const a: any = "hello"; const b: any = "hel" + "lo"; return a === b; }`,
      ),
    ).toBe(1);
  });
});
