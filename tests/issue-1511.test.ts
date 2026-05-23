import { describe, it, expect } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

describe("#1511 arguments object fidelity", () => {
  it("class method 0 formals overflow direct", async () => {
    const exports = await compileToWasm(`
      class C {
        m(): number { return arguments.length; }
      }
      export function test(): number {
        return new C().m(42, 99);
      }
    `);
    expect((exports as any).test()).toBe(2);
  });

  it("static class method 0 formals overflow direct", async () => {
    const exports = await compileToWasm(`
      class C {
        static m(): number { return arguments.length; }
      }
      export function test(): number {
        return C.m(42, 99);
      }
    `);
    expect((exports as any).test()).toBe(2);
  });

  it("object method 0 formals overflow", async () => {
    const exports = await compileToWasm(`
      const obj = {
        m(): number { return arguments.length; }
      };
      export function test(): number {
        return obj.m(42, 99);
      }
    `);
    expect((exports as any).test()).toBe(2);
  });

  it("async generator class method overflow", async () => {
    const exports = await compileToWasm(`
      class C {
        async *m(): any { yield arguments.length; }
      }
      export async function test(): Promise<number> {
        const c = new C();
        const it = c.m(42, 99);
        const r = await it.next();
        return r.value;
      }
    `);
    expect(await (exports as any).test()).toBe(2);
  });

  it("function arg overflow same arity ref", async () => {
    const exports = await compileToWasm(`
      function f(a: any, b: any): number { return arguments.length; }
      export function test(): number {
        const ref = f;
        return ref(42, 99);
      }
    `);
    expect((exports as any).test()).toBe(2);
  });

  it("C.prototype.method(args) overflow", async () => {
    const exports = await compileToWasm(`
      class C {
        m(): number { return arguments.length; }
      }
      export function test(): number {
        return C.prototype.m(42, 99 as any);
      }
    `);
    expect((exports as any).test()).toBe(2);
  });
});
