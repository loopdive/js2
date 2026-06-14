// #1965 — derived-class construction must execute the base constructor BODY.
//
// `super(args)` used to map arguments positionally onto parent struct fields
// (and replay only mined `this.x = <expr>` assignments); any computation,
// conditional, side effect, or method call in the parent constructor was
// silently dropped. Constructors are now compiled as `${Class}_init(...params,
// self)` and `super(args)` is a real call to the parent's init on the derived
// instance, so the whole chain runs base-first, exactly once.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

async function run(source: string): Promise<unknown> {
  const result = await compile(source, {});
  if (!result.success) {
    throw new Error(`compile failed:\n${result.errors.map((e) => e.message).join("\n")}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await instantiateWasm(result.binary, imports.env);
  return (instance.exports.test as () => unknown)();
}

describe("#1965 — super() runs the base constructor body", () => {
  it("base ctor computes its field (repro 1)", async () => {
    expect(
      await run(`export function test(): string {
  class A { x: number; constructor(x: number){ this.x = x*2; } }
  class B extends A { constructor(){ super(5); } }
  return String(new B().x);
}`),
    ).toBe("10");
  });

  it("ctor bodies log base-first (repro 2)", async () => {
    expect(
      await run(`export function test(): string {
  let log = "";
  class A { constructor(){ log = log + "Ac;"; } }
  class B extends A { constructor(){ super(); log = log + "Bc;"; } }
  new B();
  return log;
}`),
    ).toBe("Ac;Bc;");
  });

  it("implicit ctor still runs the base body (repro 3)", async () => {
    expect(
      await run(`export function test(): string {
  let log = "";
  class A { constructor(){ log = log + "Ac;"; } }
  class B extends A {}
  new B();
  return log;
}`),
    ).toBe("Ac;");
  });

  it("base ctor calling an overridable method dispatches to the derived override (repro 4)", async () => {
    expect(
      await run(`export function test(): string {
  let log = "";
  class A { constructor(){ this.tag(); } tag(): void { log = "A"; } }
  class B extends A { tag(): void { log = "B"; } }
  new B();
  return log;
}`),
    ).toBe("B");
  });

  it("3-level hierarchy: field inits and ctor bodies interleave base-first, each exactly once", async () => {
    expect(
      await run(`export function test(): string {
  let log = "";
  class A { fa: string = (log = log + "fA;", "a"); constructor(){ log = log + "cA;"; } }
  class B extends A { fb: string = (log = log + "fB;", "b"); constructor(){ super(); log = log + "cB;"; } }
  class C extends B { fc: string = (log = log + "fC;", "c"); constructor(){ super(); log = log + "cC;"; } }
  new C();
  return log;
}`),
    ).toBe("fA;cA;fB;cB;fC;cC;");
  });

  it("super args are bound as parent ctor parameters, not field slots", async () => {
    expect(
      await run(`export function test(): number {
  class A { x: number; constructor(x: number){ if (x > 3) { this.x = 100; } else { this.x = x; } } }
  class B extends A { constructor(n: number){ super(n + 1); } }
  return new B(8).x;
}`),
    ).toBe(100);
  });

  it("parent ctor parameter defaults fire through explicit and implicit super", async () => {
    expect(
      await run(`export function test(): number {
  class A { v: number; constructor(v: number = 7){ this.v = v * 10; } }
  class B extends A { constructor(){ super(); } }
  class C extends A {}
  return new B().v + new C().v + new C(2).v;
}`),
    ).toBe(70 + 70 + 20);
  });

  it("rest-param parent receives super args packed as a vec", async () => {
    expect(
      await run(`export function test(): number {
  class A { n: number; constructor(...vals: number[]){ this.n = vals.length; } }
  class B extends A { constructor(){ super(1, 2, 3); } }
  return new B().n;
}`),
    ).toBe(3);
  });

  it("statically-known spread super flattens to positional args", async () => {
    expect(
      await run(`export function test(): number {
  class A { x: number; y: number; constructor(x: number, y: number){ this.x = x; this.y = y; } }
  class B extends A { constructor(){ super(...[5, 6]); } }
  const b = new B();
  return b.x * 10 + b.y;
}`),
    ).toBe(56);
  });

  it("extra super args evaluate left-to-right for side effects (§13.3.7.1)", async () => {
    expect(
      await run(`export function test(): number {
  let side = 0;
  class A { x: number; constructor(x: number){ this.x = x; } }
  class B extends A { constructor(){ super(1, (side = 9)); } }
  return new B().x + side;
}`),
    ).toBe(10);
  });

  it("derived field initializer runs after super and overwrites the base body write", async () => {
    expect(
      await run(`export function test(): number {
  class A { x: number = 1; constructor(){ this.x = 2; } }
  class B extends A { x: number = 3; constructor(){ super(); } }
  return new B().x;
}`),
    ).toBe(3);
  });

  it("exception thrown in base ctor propagates out of new Derived()", async () => {
    expect(
      await run(`export function test(): number {
  class A { constructor(x: number){ if (x < 0) { throw new Error("neg"); } } }
  class B extends A { constructor(){ super(-1); } }
  try { new B(); return 1; } catch (e) { return 2; }
}`),
    ).toBe(2);
  });

  it("bare return in a base ctor still returns the instance (#2018 unregressed)", async () => {
    expect(
      await run(`export function test(): number {
  class A { x: number; constructor(x: number){ this.x = 1; if (x > 0) { return; } this.x = 2; } }
  return new A(5).x;
}`),
    ).toBe(1);
  });
});
