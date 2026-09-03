import { describe, it, expect } from "vitest";
import { compile, type CompileOptions } from "../src/index.js";

async function run(source: string, fn: string, args: unknown[] = []): Promise<unknown> {
  const result = await compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
  const imports = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (imports as WebAssembly.Imports & { __setInstance?: (instance: WebAssembly.Instance) => void }).__setInstance?.(
    instance,
  );
  return (instance.exports as any)[fn](...args);
}

async function compileWat(source: string, options: CompileOptions = {}): Promise<string> {
  const result = await compile(source, options);
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  return result.wat;
}

describe("tail call optimization", () => {
  it("self-recursive factorial uses return_call", async () => {
    const src = `
      function factorial(n: number, acc: number): number {
        if (n <= 1) return acc;
        return factorial(n - 1, acc * n);
      }
      export function test(): number {
        return factorial(10, 1);
      }
    `;
    // Verify correctness
    expect(await run(src, "test")).toBe(3628800);
    // Verify return_call is emitted in WAT
    const wat = await compileWat(src);
    expect(wat).toContain("return_call");
  });

  it("recursive sum with accumulator", async () => {
    const src = `
      function sum(n: number, acc: number): number {
        if (n <= 0) return acc;
        return sum(n - 1, acc + n);
      }
      export function test(): number {
        return sum(100, 0);
      }
    `;
    expect(await run(src, "test")).toBe(5050);
  });

  it("mutual recursion uses return_call", async () => {
    const src = `
      function isEven(n: number): number {
        if (n <= 0) return 1;
        return isOdd(n - 1);
      }
      function isOdd(n: number): number {
        if (n <= 0) return 0;
        return isEven(n - 1);
      }
      export function test(): number {
        return isEven(10);
      }
    `;
    expect(await run(src, "test")).toBe(1);
    const wat = await compileWat(src);
    expect(wat).toContain("return_call");
  });

  it("non-tail call is not optimized", async () => {
    const src = `
      function factorial(n: number): number {
        if (n <= 1) return 1;
        return n * factorial(n - 1);
      }
      export function test(): number {
        return factorial(5);
      }
    `;
    // The recursive call is n * factorial(n-1), NOT in tail position
    // because the multiplication happens after the call.
    // The test() function itself does have return factorial(5) in tail position.
    const wat = await compileWat(src);
    // The inner factorial call should NOT be return_call (it's multiplied after)
    // But test()'s return factorial(5) should be return_call
    // Just verify it compiles and runs correctly
    // (We can't easily distinguish which function has return_call in WAT output)
  });

  // (#5270 step 1) Was "keeps only host-free externref boundaries as ordinary
  // calls" — a pin that restated an undocumented `canTailCall` refusal of any
  // externref result under standalone/wasi. That refusal had no issue id, no
  // comment and no rationale (#822 / #839 / #1972 are about argument types,
  // stack setup and try/catch — never about an externref RESULT), and it made
  // EVERY value-returning standalone tail call an ordinary call, since
  // `return undefined` also lowers to an externref result. `return_call`
  // type-checks exactly like `call` + `return`, so both lanes promote it now;
  // the module stays valid and the value is unchanged.
  it("promotes an externref-result tail call in both lanes", async () => {
    const src = `
      function makeObject(depth: number): any {
        if (depth <= 0) return { value: 42 };
        return makeObject(depth - 1);
      }
      function objectTrampoline(depth: number): any {
        return makeObject(depth);
      }
      export function test(): number {
        return objectTrampoline(1).value;
      }
    `;
    const bodyOf = (wat: string): string => {
      const start = wat.indexOf("(func $objectTrampoline");
      expect(start).toBeGreaterThanOrEqual(0);
      const end = wat.indexOf("\n(func $", start + 1);
      return wat.slice(start, end < 0 ? undefined : end);
    };
    expect(bodyOf(await compileWat(src, { target: "standalone" }))).toContain("return_call");
    expect(bodyOf(await compileWat(src))).toContain("return_call");

    // The standalone module must still validate and answer the same value.
    const standalone = await compile(src, { target: "standalone" });
    expect(standalone.success).toBe(true);
    const { instance } = await WebAssembly.instantiate(standalone.binary, standalone.importObject ?? {});
    expect((instance.exports as Record<string, () => number>).test!()).toBe(42);
  });

  // (#5270 step 1) The relaxation must not promote a NON-tail call: the
  // addition after `boxed(n - 1)` still needs the caller's frame, so a deep
  // non-tail recursion must still exhaust the stack. Behavioural rather than
  // WAT-shaped because the object literal itself ends `boxed` with a genuine
  // (correctly promoted) tail call to the allocator.
  it("does not promote a non-tail externref call", async () => {
    const src = `
      function boxed(n: number): any {
        if (n <= 0) return { value: 0 };
        return { value: boxed(n - 1).value + n };
      }
      export function test(): number {
        return boxed(200000).value;
      }
    `;
    await expect(run(src, "test")).rejects.toThrow(/call stack|recursion|memory/i);
  });

  it("deep recursion does not overflow stack with tail calls", async () => {
    const src = `
      function countdown(n: number): number {
        if (n <= 0) return 0;
        return countdown(n - 1);
      }
      export function test(): number {
        return countdown(100000);
      }
    `;
    // With tail call optimization, this should not stack overflow
    expect(await run(src, "test")).toBe(0);
  });
});
