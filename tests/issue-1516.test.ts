// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1516 — Tests for GeneratorPrototype fidelity:
//   1. `Object.getPrototypeOf(g).prototype` resolves to `%GeneratorPrototype%`
//   2. `Generator.prototype.next.call(non_gen)` throws TypeError
//   3. `next`/`return`/`throw` have spec-compliant property descriptors
//   4. `Symbol.toStringTag = 'Generator'` on the prototype
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

async function run(src: string): Promise<unknown> {
  const r = await compile(src, { fileName: "test.ts" });
  if (!r.success) {
    throw new Error(`compile failed: ${JSON.stringify(r.errors)}`);
  }
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  const exports = instance.exports as Record<string, Function>;
  imports.setExports?.(exports as never);
  return exports.test!();
}

describe("#1516 GeneratorPrototype fidelity", () => {
  it("Object.getPrototypeOf(g).prototype is the GeneratorPrototype singleton", async () => {
    // Two distinct generator functions should share the same %GeneratorPrototype%
    // and that prototype should have a `next` method.
    const src = `
      function* g() {}
      function* h() { yield 1; }
      export function test(): number {
        const pa = Object.getPrototypeOf(g);
        const pb = Object.getPrototypeOf(h);
        const sameOuter = pa === pb ? 1 : 0;
        const ga: any = pa;
        const gb: any = pb;
        const sameInner = ga.prototype === gb.prototype ? 1 : 0;
        const hasNext = typeof ga.prototype.next === "function" ? 1 : 0;
        const hasReturn = typeof ga.prototype.return === "function" ? 1 : 0;
        const hasThrow = typeof ga.prototype.throw === "function" ? 1 : 0;
        return sameOuter + sameInner + hasNext + hasReturn + hasThrow;
      }
    `;
    expect(await run(src)).toBe(5);
  });

  it("Generator.prototype.next.call(non_gen) throws TypeError", async () => {
    const src = `
      function* g() {}
      export function test(): number {
        const GP: any = Object.getPrototypeOf(g).prototype;
        let count = 0;
        try { GP.next.call({}); } catch (e: any) { if (e instanceof TypeError) count++; }
        try { GP.next.call(null); } catch (e: any) { if (e instanceof TypeError) count++; }
        try { GP.return.call({}); } catch (e: any) { if (e instanceof TypeError) count++; }
        try { GP.throw.call({}, "x"); } catch (e: any) { if (e instanceof TypeError) count++; }
        return count;
      }
    `;
    expect(await run(src)).toBe(4);
  });

  it("Generator.prototype.next called on a real generator works", async () => {
    const src = `
      function* g() { yield 42; }
      export function test(): number {
        const GP: any = Object.getPrototypeOf(g).prototype;
        const it = g();
        const r1 = GP.next.call(it);
        // r1 must be { value: 42, done: false }
        if (r1.value !== 42 || r1.done) return -1;
        const r2 = GP.next.call(it);
        if (r2.done !== true) return -2;
        return 1;
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("GeneratorPrototype has Symbol.toStringTag = 'Generator'", async () => {
    const src = `
      function* g() {}
      export function test(): number {
        const GP: any = Object.getPrototypeOf(g).prototype;
        return GP[Symbol.toStringTag] === "Generator" ? 1 : 0;
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("GeneratorPrototype.next/return/throw have writable: true, enumerable: false, configurable: true", async () => {
    const src = `
      function* g() {}
      export function test(): number {
        const GP: any = Object.getPrototypeOf(g).prototype;
        let ok = 0;
        for (const name of ["next", "return", "throw"]) {
          const d = Object.getOwnPropertyDescriptor(GP, name);
          if (!d) continue;
          if (d.writable === true && d.enumerable === false && d.configurable === true) ok++;
        }
        return ok;
      }
    `;
    expect(await run(src)).toBe(3);
  });

  it("GeneratorPrototype.next.length === 1 with correct descriptor", async () => {
    const src = `
      function* g() {}
      export function test(): number {
        const GP: any = Object.getPrototypeOf(g).prototype;
        const d = Object.getOwnPropertyDescriptor(GP.next, "length");
        if (!d) return -1;
        if (d.value !== 1) return -2;
        if (d.writable !== false) return -3;
        if (d.enumerable !== false) return -4;
        if (d.configurable !== true) return -5;
        return 1;
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("Generator instance's prototype is %GeneratorPrototype%", async () => {
    const src = `
      function* g() { yield 1; }
      export function test(): number {
        const it: any = g();
        const itProto = Object.getPrototypeOf(it);
        const fromG = Object.getPrototypeOf(g).prototype;
        return itProto === fromG ? 1 : 0;
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("regular function-call iteration still works (regression check)", async () => {
    const src = `
      function* gen(n: number): Generator<number> {
        for (let i = 0; i < n; i++) yield i;
      }
      export function test(): number {
        let sum = 0;
        for (const x of gen(5)) sum += x;
        return sum;
      }
    `;
    expect(await run(src)).toBe(10);
  });
});
