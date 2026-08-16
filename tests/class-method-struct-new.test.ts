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

describe("class method struct.new type mismatch (#582)", () => {
  it("method returns new instance of same class", { timeout: 30000 }, async () => {
    expect(
      await run(
        `
      class Point {
        x: number;
        y: number;
        constructor(x: number, y: number) {
          this.x = x;
          this.y = y;
        }
        add(other: Point): Point {
          return new Point(this.x + other.x, this.y + other.y);
        }
      }
      export function test(): number {
        const a = new Point(1, 2);
        const b = new Point(3, 4);
        const c = a.add(b);
        return c.x + c.y;
      }
    `,
        "test",
      ),
    ).toBe(10);
  });

  it("method creates instance of child class", { timeout: 30000 }, async () => {
    expect(
      await run(
        `
      class Animal {
        legs: number;
        constructor(legs: number) {
          this.legs = legs;
        }
        clone(): Animal {
          return new Animal(this.legs);
        }
      }
      class Dog extends Animal {
        speed: number;
        constructor(legs: number, speed: number) {
          super(legs);
          this.speed = speed;
        }
      }
      export function test(): number {
        const d = new Dog(4, 30);
        const c = d.clone();
        return c.legs;
      }
    `,
        "test",
      ),
    ).toBe(4);
  });

  it("method creates instance of different class", { timeout: 30000 }, async () => {
    expect(
      await run(
        `
      class Foo {
        value: number;
        constructor(v: number) {
          this.value = v;
        }
        makeBar(): Bar {
          return new Bar(this.value * 2);
        }
      }
      class Bar {
        value: number;
        constructor(v: number) {
          this.value = v;
        }
      }
      export function test(): number {
        const f = new Foo(5);
        const b = f.makeBar();
        return b.value;
      }
    `,
        "test",
      ),
    ).toBe(10);
  });

  it("static method creates instance", { timeout: 30000 }, async () => {
    expect(
      await run(
        `
      class Counter {
        count: number;
        constructor(c: number) {
          this.count = c;
        }
        static create(): Counter {
          return new Counter(0);
        }
        increment(): Counter {
          return new Counter(this.count + 1);
        }
      }
      export function test(): number {
        const c = Counter.create();
        const c2 = c.increment();
        return c2.count;
      }
    `,
        "test",
      ),
    ).toBe(1);
  });
});
