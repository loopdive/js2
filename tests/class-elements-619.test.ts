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

describe("Issue #619: class element handlers", () => {
  it("class with field declarations and initializers", async () => {
    const result = await run(
      `
      class Foo {
        x: number = 42;
        y: number = 10;
      }
      export function test(): number {
        const f = new Foo();
        return f.x + f.y;
      }
    `,
      "test",
    );
    expect(result).toBe(52);
  });

  it("class with private fields", async () => {
    const result = await run(
      `
      class Counter {
        #count: number = 0;
        increment() { this.#count++; }
        getCount(): number { return this.#count; }
      }
      export function test(): number {
        const c = new Counter();
        c.increment();
        c.increment();
        c.increment();
        return c.getCount();
      }
    `,
      "test",
    );
    expect(result).toBe(3);
  });

  it("class with semicolon class elements", async () => {
    const result = await run(
      `
      class MyClass {
        x: number = 10;
        ;
        y: number = 20;
        ;
        getSum(): number { return this.x + this.y; }
      }
      export function test(): number {
        const m = new MyClass();
        return m.getSum();
      }
    `,
      "test",
    );
    expect(result).toBe(30);
  });

  it("class with field initializers using expressions", async () => {
    const result = await run(
      `
      class Config {
        a: number = 1 + 2;
        b: number = 10 * 3;
      }
      export function test(): number {
        const c = new Config();
        return c.a + c.b;
      }
    `,
      "test",
    );
    expect(result).toBe(33);
  });

  it("class with property declaration no initializer", async () => {
    const result = await run(
      `
      class Point {
        x: number;
        y: number;
        constructor(x: number, y: number) {
          this.x = x;
          this.y = y;
        }
      }
      export function test(): number {
        const p = new Point(3, 4);
        return p.x + p.y;
      }
    `,
      "test",
    );
    expect(result).toBe(7);
  });

  it("class with static and instance fields", async () => {
    const result = await run(
      `
      class Foo {
        static defaultValue: number = 99;
        value: number;
        constructor(v: number) {
          this.value = v;
        }
        getWithDefault(): number {
          return this.value + Foo.defaultValue;
        }
      }
      export function test(): number {
        const f = new Foo(1);
        return f.getWithDefault();
      }
    `,
      "test",
    );
    expect(result).toBe(100);
  });
});
