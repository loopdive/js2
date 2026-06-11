import { describe, it, expect } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

// #2082: a derived class with NO explicit constructor and a WasmGC-struct parent
// must forward its arguments to the parent (spec §15.7.14
// `constructor(...args) { super(...args); }`). The implicit ctor was synthesized
// with zero parameters, so `new Dog("rex")` evaluated the argument and DROPPED
// it — the replayed parent `this.name = name` saw `name` unresolved (ref.null /
// f64 0). The fix forwards the nearest-ancestor ctor's parameter list.

async function evalStr(body: string): Promise<unknown> {
  const exports = await compileToWasm(body);
  return (exports as { test: () => unknown }).test();
}
async function evalNum(body: string): Promise<unknown> {
  const exports = await compileToWasm(body);
  return (exports as { test: () => unknown }).test();
}

describe("#2082 implicit derived constructor forwards args", () => {
  it("forwards a single string arg to the parent (the original repro)", async () => {
    expect(
      await evalStr(
        `class Animal { name: string; constructor(name: string){ this.name = name; } speak(){ return this.name + " barks"; } } class Dog extends Animal {} export function test(): string { return new Dog("rex").speak(); }`,
      ),
    ).toBe("rex barks");
    expect(
      await evalStr(
        `class Animal { name: string; constructor(name: string){ this.name = name; } } class Dog extends Animal {} export function test(): string { return new Dog("rex").name; }`,
      ),
    ).toBe("rex");
  });

  it("forwards multiple args", async () => {
    expect(
      await evalNum(
        `class P { a: number; b: number; constructor(a: number, b: number){ this.a=a; this.b=b; } } class C extends P {} export function test(): number { const c = new C(3, 4); return c.a * 10 + c.b; }`,
      ),
    ).toBe(34);
  });

  it("forwards through multi-level implicit chains", async () => {
    expect(
      await evalStr(
        `class A { x: string; constructor(x: string){ this.x = x; } } class B extends A {} class D extends B {} export function test(): string { return new D("hi").x; }`,
      ),
    ).toBe("hi");
    expect(
      await evalNum(
        `class A { a: number; b: number; constructor(a: number, b: number){ this.a=a; this.b=b; } } class B extends A {} class C extends B {} export function test(): number { const c = new C(5, 6); return c.a - c.b; }`,
      ),
    ).toBe(-1);
  });

  it("honours forwarded parent default parameters", async () => {
    expect(
      await evalNum(
        `class A { v: number; constructor(v: number = 7){ this.v = v; } } class B extends A {} export function test(): number { return new B().v; }`,
      ),
    ).toBe(7);
    expect(
      await evalNum(
        `class A { v: number; constructor(v: number = 7){ this.v = v; } } class B extends A {} export function test(): number { return new B(3).v; }`,
      ),
    ).toBe(3);
  });

  it("runs parent field initializers alongside forwarded ctor args", async () => {
    expect(
      await evalStr(
        `class A { tag = "A"; name: string; constructor(n: string){ this.name = n; } } class B extends A {} export function test(): string { const b = new B("x"); return b.tag + b.name; }`,
      ),
    ).toBe("Ax");
  });

  it("does not regress an explicit derived constructor", async () => {
    expect(
      await evalStr(
        `class Animal { name: string; constructor(name: string){ this.name = name; } } class Dog extends Animal { constructor(n: string){ super(n); } } export function test(): string { return new Dog("rex").name; }`,
      ),
    ).toBe("rex");
  });
});
