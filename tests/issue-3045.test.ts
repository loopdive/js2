// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3045 (partial) — a class-EXPRESSION binding (`const/var C = class { ... }`)
// must hold the constructor-object VALUE, so reading `C` as an rvalue works.
//
// Before this fix, `src/codegen/statements/variables.ts` SKIPPED the
// class-expression initializer ("already handled as class declaration"), so the
// (pre-hoisted, instance-struct-typed) local `$C` was declared but never stored.
// Reading `C` as a value then read an uninitialized null local, and coercing
// that null to externref for a host import threw
// `TypeError: Reflect.has called on non-object` /
// `Cannot convert undefined or null to object`. The fix routes class-expression
// initializers through the same "compile initializer → re-type the slot → store"
// path already used for arrow / function-expression bindings.
//
// NOTE: the private-method conformance tests this was harvested from (#3045's 8
// files) ALSO require a *separate, deeper* fix — class-expression method /
// constructor bodies do not capture the enclosing function's scope the way class
// *declarations* do (tied to the #779a captured-global machinery). That work is
// tracked separately; this file covers only the value-materialization fix.

import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function compileAndRun(source: string): Promise<number> {
  const r = await compile(source, { fileName: "test.ts" });
  if (!r.binary || r.binary.length === 0) {
    throw new Error("compile failed: " + (r.errors ?? []).map((e) => e.message).join("; "));
  }
  const { instance } = await WebAssembly.instantiate(r.binary, buildImports(r.imports, undefined, r.stringPool));
  return (instance.exports.test as () => number)();
}

describe("#3045 — class-expression binding holds the constructor value", () => {
  it("Reflect.has on a class-expression value does not trap (returns false for a missing key)", async () => {
    // Was: TypeError: Reflect.has called on non-object.
    expect(
      await compileAndRun(
        `export function test(): number { const C = class { m() { return 1; } }; return Reflect.has(C, "x") ? 0 : 1; }`,
      ),
    ).toBe(1);
  });

  it("hasOwnProperty.call on a class-expression value does not trap", async () => {
    // Was: TypeError: Cannot convert undefined or null to object.
    expect(
      await compileAndRun(
        `export function test(): number { const C = class { m() { return 1; } }; return Object.prototype.hasOwnProperty.call(C, "x") ? 0 : 1; }`,
      ),
    ).toBe(1);
  });

  it("class-expression value passed to a user function is a real object", async () => {
    expect(
      await compileAndRun(
        `function isObj(x: any): number { return (typeof x === "object" || typeof x === "function") ? 1 : 0; } export function test(): number { const C = class { m() { return 1; } }; return isObj(C); }`,
      ),
    ).toBe(1);
  });

  it("var form (test262 harness shape) also materializes the value", async () => {
    expect(
      await compileAndRun(
        `export function test(): number { var C = class { #m() { return 1; } }; return Reflect.has(C, "x") ? 0 : 1; }`,
      ),
    ).toBe(1);
  });

  it("named class expression value is materialized", async () => {
    expect(
      await compileAndRun(
        `export function test(): number { const C = class D { m() { return 1; } }; return Reflect.has(C, "x") ? 0 : 1; }`,
      ),
    ).toBe(1);
  });

  // Regression guards: construction / methods / statics still work after routing
  // class expressions through the value-store path.
  it("new C() on a class expression still constructs and runs methods", async () => {
    expect(
      await compileAndRun(
        `export function test(): number { const C = class { v: number = 0; constructor(x: number) { this.v = x * 2; } m() { return this.v; } }; return new C(5).m(); }`,
      ),
    ).toBe(10);
  });

  it("two instances of a class-expression class are independent", async () => {
    expect(
      await compileAndRun(
        `export function test(): number { const C = class { v: number; constructor(x: number) { this.v = x; } }; return new C(3).v + new C(4).v; }`,
      ),
    ).toBe(7);
  });

  it("static member of a class expression is readable", async () => {
    expect(
      await compileAndRun(`export function test(): number { const C = class { static s: number = 9; }; return C.s; }`),
    ).toBe(9);
  });

  it("class-expression instance passed between functions preserves fields", async () => {
    expect(
      await compileAndRun(
        `function f(x: any): number { return x.v; } export function test(): number { const C = class { v: number = 8; }; return f(new C()); }`,
      ),
    ).toBe(8);
  });
});

// #3045 Bug 2 — a class EXPRESSION nested in a function must capture the
// enclosing function scope in its constructor/method/accessor bodies, exactly
// as a class DECLARATION does. Before this fix, the class-expression body was
// compiled eagerly at module scope (BEFORE the enclosing function's nested
// functions were registered and BEFORE its captured locals were promoted to
// module globals) so enclosing calls returned garbage and enclosing writes were
// dropped. The fix defers the body to the in-scope variable path (via
// `compileNestedClassDeclaration`), which runs `promoteAccessorCapturesToGlobals`
// then `compileClassBodies` with the enclosing function context live.
describe("#3045 Bug 2 — class-expression bodies capture the enclosing function scope", () => {
  it("method reads an enclosing let (by-value capture)", async () => {
    expect(
      await compileAndRun(
        `export function test(): number { let base = 100; const C = class { m() { return base + 1; } }; return new C().m(); }`,
      ),
    ).toBe(101);
  });

  it("constructor writes an enclosing let (write propagates out)", async () => {
    expect(
      await compileAndRun(
        `export function test(): number { let seen = 0; const C = class { constructor() { seen = 42; } }; new C(); return seen; }`,
      ),
    ).toBe(42);
  });

  it("method calls an enclosing function declaration (correct args/return)", async () => {
    expect(
      await compileAndRun(
        `export function test(): number { function dbl(n: number): number { return n * 2; } const C = class { m() { return dbl(21); } }; return new C().m(); }`,
      ),
    ).toBe(42);
  });

  it("getter captures an enclosing local", async () => {
    expect(
      await compileAndRun(
        `export function test(): number { let x = 9; const C = class { get g() { return x; } }; return new C().g; }`,
      ),
    ).toBe(9);
  });

  it("the 8-file shape: ctor/method calls an enclosing fn that mutates AND returns an enclosing local", async () => {
    // Mirrors the harvested private-method tests' `hasProp`: the class-expression
    // constructor calls a `test()`-local helper that both writes an enclosing
    // `let` and returns a value the caller consumes. This is the exact Bug-2
    // regression the harvest mislabeled as "Reflect.has called on non-object".
    expect(
      await compileAndRun(
        `export function test(): number { let seen = 0; function bump(n: number): number { seen = seen + n; return n * 10; } const C = class { m() { return bump(3); } }; const r = new C().m(); return r + seen; }`,
      ),
    ).toBe(33);
  });

  it("generator method captures an enclosing local", async () => {
    expect(
      await compileAndRun(
        `export function test(): number { let base = 40; const C = class { *g() { yield base; yield base + 1; yield base + 2; } }; let sum = 0; for (const v of new C().g()) sum += v; return sum; }`,
      ),
    ).toBe(123);
  });

  it("named class expression captures an enclosing local", async () => {
    expect(
      await compileAndRun(
        `export function test(): number { let z = 3; const C = class Named { m() { return z + 1; } }; return new C().m(); }`,
      ),
    ).toBe(4);
  });

  it("a nested arrow inside a class-expression method captures the enclosing scope", async () => {
    expect(
      await compileAndRun(
        `export function test(): number { let q = 11; const C = class { m() { const f = () => q * 2; return f(); } }; return new C().m(); }`,
      ),
    ).toBe(22);
  });

  it("regression guard: a non-capturing in-function class expression still works", async () => {
    expect(
      await compileAndRun(
        `export function test(): number { const C = class { v: number; constructor(v: number) { this.v = v; } getV() { return this.v; } }; return new C(7).getV(); }`,
      ),
    ).toBe(7);
  });

  it("declaration/expression parity: same capture shape yields the same result", async () => {
    const shape = (kw: string) =>
      `export function test(): number { let seen = 0; function bump(n: number): number { seen = seen + n; return n * 10; } ${kw} const r = new C().m(); return r + seen; }`;
    const decl = await compileAndRun(shape("class C { m() { return bump(3); } }"));
    const expr = await compileAndRun(shape("const C = class { m() { return bump(3); } };"));
    expect(expr).toBe(decl);
    expect(expr).toBe(33);
  });
});
