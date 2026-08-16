import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function run(source: string, fn: string, args: unknown[] = []): Promise<unknown> {
  const result = await compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
  // (#4507) Instantiate through the compiler's own import object (#1667).
  // A bare `{ env: {} }` omits the `string_constants` namespace, so every test
  // in this file died at INSTANTIATION with
  //   Import #0 module="string_constants": module is not an object or function
  // before any assertion ran.
  const imports = result.importObject ?? { env: {} };
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (imports as WebAssembly.Imports & { __setInstance?: (instance: WebAssembly.Instance) => void }).__setInstance?.(
    instance,
  );
  return (instance.exports as any)[fn](...args);
}

describe("static class members", () => {
  it("static method without parameters", async () => {
    expect(
      await run(
        `
      class MathUtil {
        static double(x: number): number {
          return x * 2;
        }
      }
      export function main(): number {
        return MathUtil.double(21);
      }
    `,
        "main",
      ),
    ).toBe(42);
  });

  it("static method with multiple parameters", async () => {
    expect(
      await run(
        `
      class Calculator {
        static add(a: number, b: number): number {
          return a + b;
        }
        static multiply(a: number, b: number): number {
          return a * b;
        }
      }
      export function main(): number {
        return Calculator.add(3, 4) + Calculator.multiply(2, 5);
      }
    `,
        "main",
      ),
    ).toBe(17);
  });

  it("static property read and write", async () => {
    expect(
      await run(
        `
      class Counter {
        static count: number;
      }
      export function main(): number {
        Counter.count = 10;
        Counter.count = Counter.count + 5;
        return Counter.count;
      }
    `,
        "main",
      ),
    ).toBe(15);
  });

  it("static property with initializer", async () => {
    expect(
      await run(
        `
      class Config {
        static maxRetries: number = 3;
      }
      export function main(): number {
        return Config.maxRetries;
      }
    `,
        "main",
      ),
    ).toBe(3);
  });

  it("static method modifying static property", async () => {
    expect(
      await run(
        `
      class Counter {
        static count: number;
        static increment(): void {
          Counter.count = Counter.count + 1;
        }
        static getCount(): number {
          return Counter.count;
        }
      }
      export function main(): number {
        Counter.count = 0;
        Counter.increment();
        Counter.increment();
        Counter.increment();
        return Counter.getCount();
      }
    `,
        "main",
      ),
    ).toBe(3);
  });

  it("mix of static and instance members", async () => {
    expect(
      await run(
        `
      class Item {
        static totalItems: number;
        value: number;
        constructor(v: number) {
          this.value = v;
          Item.totalItems = Item.totalItems + 1;
        }
        getValue(): number {
          return this.value;
        }
        static getTotal(): number {
          return Item.totalItems;
        }
      }
      export function main(): number {
        Item.totalItems = 0;
        const a = new Item(10);
        const b = new Item(20);
        const c = new Item(30);
        return a.getValue() + b.getValue() + Item.getTotal();
      }
    `,
        "main",
      ),
    ).toBe(33);
  });

  it("static method returning boolean", async () => {
    expect(
      await run(
        `
      class Validator {
        static isPositive(n: number): boolean {
          return n > 0;
        }
      }
      export function main(): number {
        if (Validator.isPositive(5)) {
          return 1;
        }
        return 0;
      }
    `,
        "main",
      ),
    ).toBe(1);
  });

  it("static method called from regular function", async () => {
    expect(
      await run(
        `
      class MathHelper {
        static square(x: number): number {
          return x * x;
        }
      }
      function computeHypotenuse(a: number, b: number): number {
        return MathHelper.square(a) + MathHelper.square(b);
      }
      export function main(): number {
        return computeHypotenuse(3, 4);
      }
    `,
        "main",
      ),
    ).toBe(25);
  });
});
