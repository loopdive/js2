import { describe, it, expect } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

describe("Issue #139: valueOf/toString coercion on arithmetic operators", () => {
  it("unary minus on object with valueOf", async () => {
    const exports = await compileToWasm(`
      class Obj {
        val: number;
        constructor(v: number) { this.val = v; }
        valueOf(): number { return this.val; }
      }

      export function test(): number {
        const obj = new Obj(5);
        return -obj;
      }
    `);
    expect(exports.test()).toBe(-5);
  });

  it("arithmetic multiplication with valueOf object", async () => {
    const exports = await compileToWasm(`
      class Num {
        val: number;
        constructor(v: number) { this.val = v; }
        valueOf(): number { return this.val; }
      }

      export function test(): number {
        const a = new Num(10);
        return a * 3;
      }
    `);
    expect(exports.test()).toBe(30);
  });

  it("all arithmetic operators with valueOf", async () => {
    const exports = await compileToWasm(`
      class Num {
        val: number;
        constructor(v: number) { this.val = v; }
        valueOf(): number { return this.val; }
      }

      export function add(): number { const n = new Num(5); return n + 3; }
      export function sub(): number { const n = new Num(10); return n - 3; }
      export function mul(): number { const n = new Num(4); return n * 5; }
      export function div(): number { const n = new Num(20); return n / 4; }
      export function mod(): number { const n = new Num(17); return n % 5; }
      export function neg(): number { const n = new Num(7); return -n; }
      export function pos(): number { const n = new Num(42); return +n; }
    `);
    expect(exports.add()).toBe(8);
    expect(exports.sub()).toBe(7);
    expect(exports.mul()).toBe(20);
    expect(exports.div()).toBe(5);
    expect(exports.mod()).toBe(2);
    expect(exports.neg()).toBe(-7);
    expect(exports.pos()).toBe(42);
  });

  it("both operands are valueOf objects", async () => {
    const exports = await compileToWasm(`
      class Num {
        val: number;
        constructor(v: number) { this.val = v; }
        valueOf(): number { return this.val; }
      }

      export function test(): number {
        const a = new Num(6);
        const b = new Num(7);
        return a * b;
      }
    `);
    expect(exports.test()).toBe(42);
  });
});
