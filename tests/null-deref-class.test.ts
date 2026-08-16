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

describe("null pointer dereference in class instances", () => {
  it("class with property access in methods", async () => {
    const result = await run(
      `
      class Counter {
        count: number;
        constructor() {
          this.count = 0;
        }
        increment() {
          this.count = this.count + 1;
        }
        getCount(): number {
          return this.count;
        }
      }
      const c = new Counter();
      c.increment();
      c.increment();
      c.increment();
      export function main(): number { return c.getCount(); }
    `,
      "main",
    );
    expect(result).toBe(3);
  });

  it("class expression assigned to variable", async () => {
    const result = await run(
      `
      const MyClass = class {
        value: number;
        constructor(v: number) {
          this.value = v;
        }
        getValue(): number {
          return this.value;
        }
      };
      const obj = new MyClass(42);
      export function main(): number { return obj.getValue(); }
    `,
      "main",
    );
    expect(result).toBe(42);
  });

  it("method modifying and reading this.prop", async () => {
    const result = await run(
      `
      class Adder {
        sum: number;
        constructor() {
          this.sum = 0;
        }
        add(n: number): void {
          this.sum = this.sum + n;
        }
        getSum(): number {
          return this.sum;
        }
      }
      const a = new Adder();
      a.add(10);
      a.add(20);
      export function main(): number { return a.getSum(); }
    `,
      "main",
    );
    expect(result).toBe(30);
  });

  it("chained property reads on returned objects", async () => {
    const result = await run(
      `
      class Wrapper {
        inner: number;
        constructor(v: number) {
          this.inner = v;
        }
      }
      function makeWrapper(v: number): Wrapper {
        return new Wrapper(v);
      }
      export function main(): number {
        const w = makeWrapper(99);
        return w.inner;
      }
    `,
      "main",
    );
    expect(result).toBe(99);
  });
});
