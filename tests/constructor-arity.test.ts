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

describe("constructor arity - preserve trailing undefined args (#593)", () => {
  it("should correctly construct class with trailing undefined-like args", async () => {
    // This tests that the compiler handles constructors with multiple args
    // including ones that may be null/undefined at runtime
    const result = await run(
      `
      class Foo {
        a: number;
        b: number;
        c: number;
        constructor(a: number, b: number, c: number) {
          this.a = a;
          this.b = b;
          this.c = c;
        }
        sum(): number {
          return this.a + this.b + this.c;
        }
      }
      export function test(): number {
        const f = new Foo(1, 0, 0);
        return f.sum();
      }
    `,
      "test",
    );
    expect(result).toBe(1);
  });
});
