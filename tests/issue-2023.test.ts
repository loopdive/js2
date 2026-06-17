import { describe, it, expect } from "vitest";
import { compileAndInstantiate } from "../src/runtime-instantiate.js";

// (#2023) `new.target` used to lower to a constant `i32.const 1` truthiness
// stub, so identity comparisons (`new.target === SomeClass`) were always wrong
// — `new A()` and `new B() extends A` both reported the same target.
//
// The fix threads a class-id through a module global set at the outermost `new`
// site (and preserved across `super()`), so `new.target === Class` is an honest
// runtime identity check while truthiness uses stay correct.

async function run<T = unknown>(src: string, fn: string, args: unknown[] = []): Promise<T> {
  const exports = (await compileAndInstantiate(src)) as Record<string, (...a: unknown[]) => T>;
  return exports[fn]!(...args);
}

describe("#2023 new.target identity", () => {
  it("new.target === DirectClass is true; via subclass super() is false", async () => {
    const src = `
      class A {
        tag: number;
        constructor() { this.tag = (new.target === A) ? 1 : 2; }
        getTag(): number { return this.tag; }
      }
      class B extends A {}
      export function ta(): number { return new A().getTag(); }
      export function tb(): number { return new B().getTag(); }
    `;
    expect(await run<number>(src, "ta")).toBe(1);
    expect(await run<number>(src, "tb")).toBe(2);
  });

  it("matches Node through the super chain (string repro from the issue)", async () => {
    const src = `
      class A {
        tag: string;
        constructor() { this.tag = new.target === A ? "direct" : "sub"; }
      }
      class B extends A {}
      export function r(): string { return new A().tag + "|" + new B().tag; }
    `;
    expect(await run<string>(src, "r")).toBe("direct|sub");
  });

  it("resolves the derived-most class three levels deep", async () => {
    const src = `
      class A {
        id: number;
        constructor() { this.id = (new.target === A) ? 1 : (new.target === B ? 2 : 3); }
        get(): number { return this.id; }
      }
      class B extends A {}
      class C extends B {}
      export function a(): number { return new A().get(); }
      export function b(): number { return new B().get(); }
      export function c(): number { return new C().get(); }
    `;
    expect(await run<number>(src, "a")).toBe(1);
    expect(await run<number>(src, "b")).toBe(2);
    expect(await run<number>(src, "c")).toBe(3);
  });

  it("keeps new.target truthy inside a constructor", async () => {
    const src = `
      class A {
        v: number;
        constructor() { this.v = new.target ? 10 : 20; }
        get(): number { return this.v; }
      }
      export function t(): number { return new A().get(); }
    `;
    expect(await run<number>(src, "t")).toBe(10);
  });

  it("restores the outer new.target after a nested `new` in a ctor body", async () => {
    const src = `
      class Inner {
        tag: number;
        constructor() { this.tag = (new.target === Inner) ? 1 : 9; }
        g(): number { return this.tag; }
      }
      class Outer {
        r: number;
        constructor() {
          const i = new Inner();
          this.r = (new.target === Outer ? 100 : 0) + i.g();
        }
        g(): number { return this.r; }
      }
      export function o(): number { return new Outer().g(); }
    `;
    // Inner sees Inner (1); Outer's new.target is correctly restored after the
    // nested construction (100), so the result is 101.
    expect(await run<number>(src, "o")).toBe(101);
  });

  it("new.target is falsy when read outside a constructor", async () => {
    const src = `
      function g(): number { return new.target ? 1 : 0; }
      export function h(): number { return g(); }
    `;
    expect(await run<number>(src, "h")).toBe(0);
  });

  it("does not regress the named-function-expression self-recursion control", async () => {
    const src = `
      export function f(): number {
        const fact = function fact(n: number): number { return n <= 1 ? 1 : n * fact(n - 1); };
        return fact(5);
      }
    `;
    expect(await run<number>(src, "f")).toBe(120);
  });
});
