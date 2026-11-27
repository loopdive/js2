import { describe, it, expect } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

describe("Issue #254: Private class fields and methods (#field)", () => {
  it("private field assignment in constructor", async () => {
    const exports = await compileToWasm(`
      class Counter {
        #count;
        constructor() {
          this.#count = 0;
        }
        getCount() {
          return this.#count;
        }
      }
      export function test(): number {
        const c = new Counter();
        return c.getCount();
      }
    `);
    expect(exports.test()).toBe(0);
  });

  it("private field mutation in methods", async () => {
    const exports = await compileToWasm(`
      class Counter {
        #count;
        constructor() {
          this.#count = 0;
        }
        increment() {
          this.#count = this.#count + 1;
        }
        getCount() {
          return this.#count;
        }
      }
      export function test(): number {
        const c = new Counter();
        c.increment();
        c.increment();
        c.increment();
        return c.getCount();
      }
    `);
    expect(exports.test()).toBe(3);
  });

  it("multiple private fields", async () => {
    const exports = await compileToWasm(`
      class Point {
        #x;
        #y;
        constructor(x, y) {
          this.#x = x;
          this.#y = y;
        }
        sum() {
          return this.#x + this.#y;
        }
      }
      export function test(): number {
        const p = new Point(10, 20);
        return p.sum();
      }
    `);
    expect(exports.test()).toBe(30);
  });

  it("private field with initializer", async () => {
    const exports = await compileToWasm(`
      class Box {
        #value = 42;
        getValue() {
          return this.#value;
        }
      }
      export function test(): number {
        const b = new Box();
        return b.getValue();
      }
    `);
    expect(exports.test()).toBe(42);
  });

  it("private field compound assignment", async () => {
    const exports = await compileToWasm(`
      class Accumulator {
        #total = 0;
        add(n) {
          this.#total = this.#total + n;
        }
        getTotal() {
          return this.#total;
        }
      }
      export function test(): number {
        const a = new Accumulator();
        a.add(5);
        a.add(10);
        a.add(15);
        return a.getTotal();
      }
    `);
    expect(exports.test()).toBe(30);
  });
});
