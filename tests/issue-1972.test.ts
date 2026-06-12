// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1972 — `try { return f(); } catch { ... }` never caught. Wasm
// `return_call` replaces the caller frame, so the callee's throw unwound
// past the enclosing catch handler and escaped to the host. The tail-call
// rewrite is now suppressed while compiling a try block that has a catch
// clause (FunctionContext.tryCatchDepth), exactly as it already was for
// pending finally blocks.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const ENV_STUB = {
  console_log_number: () => {},
  console_log_string: () => {},
  console_log_bool: () => {},
};

async function compileSrc(source: string) {
  const result = await compile(source);
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  return result;
}

async function instantiate(result: Awaited<ReturnType<typeof compileSrc>>) {
  const imports = buildImports(result.imports, ENV_STUB, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return instance;
}

async function run(source: string, fn = "test", args: unknown[] = []): Promise<unknown> {
  const instance = await instantiate(await compileSrc(source));
  return (instance.exports as any)[fn](...args);
}

describe("#1972 — no return_call inside try with a catch handler", () => {
  it("try { return boom(); } catch returns the catch value", async () => {
    const src = `
      function boom(): number { throw new Error("kaboom"); }
      export function test(): number {
        try { return boom(); } catch (e) { return 42; }
      }
    `;
    expect(await run(src)).toBe(42);
    const { wat } = await compileSrc(src);
    expect(wat).not.toContain("return_call");
  });

  it("return_call_ref path: indirect call in return position inside try", async () => {
    const src = `
      function boom(n: number): number { throw new Error("x"); }
      export function test(n: number): number {
        const f: (n: number) => number = boom;
        try { return f(n); } catch (e) { return 7; }
      }
    `;
    expect(await run(src, "test", [1])).toBe(7);
    const { wat } = await compileSrc(src);
    expect(wat).not.toContain("return_call_ref");
  });

  it("tail calls outside try still emit return_call", async () => {
    // The `throw new Error` keeps this function on the legacy codegen path
    // (the experimental-IR path, which currently re-lowers simple numeric
    // functions WITHOUT tail calls, rejects it) so the assertion exercises
    // the emitReturnTail rewrite this fix touched.
    const src = `
      function helper(n: number, acc: number): number {
        if (n <= 0) return acc;
        return helper(n - 1, acc + n);
      }
      export function test(n: number, m: number): number {
        if (n < -1e9) throw new Error("never");
        return helper(n, m);
      }
    `;
    expect(await run(src, "test", [100, 0])).toBe(5050);
    const { wat } = await compileSrc(src);
    expect(wat).toContain("return_call");
  });

  it("return inside the catch body is still tail-call eligible", async () => {
    const src = `
      function fallback(n: number): number {
        if (n <= 0) return 0;
        return fallback(n - 1);
      }
      export function test(n: number): number {
        try { throw new Error("x"); } catch (e) { return fallback(n); }
      }
    `;
    expect(await run(src, "test", [5])).toBe(0);
    const { wat } = await compileSrc(src);
    // The catch body compiles after this try's handler scope closes, so its
    // tail position is rewritten — only returns inside the TRY body are not.
    expect(wat).toContain("return_call");
  });

  it("return after the try statement is tail-call eligible again", async () => {
    const src = `
      function safe(n: number): number {
        if (n <= 0) return 1;
        return safe(n - 1);
      }
      export function test(n: number): number {
        try { if (n < -1e9) throw new Error("x"); } catch (e) { return -1; }
        return safe(n);
      }
    `;
    expect(await run(src, "test", [3])).toBe(1);
    const { wat } = await compileSrc(src);
    expect(wat).toContain("return_call");
  });

  it("nested try: inner return is caught by the inner handler", async () => {
    const src = `
      function boom(): number { throw new Error("inner"); }
      export function test(): number {
        try {
          try { return boom(); } catch (e) { return 10; }
        } catch (e) {
          return 20;
        }
      }
    `;
    expect(await run(src)).toBe(10);
  });

  it("throw from a deeper statement inside try is still caught", async () => {
    const src = `
      function boom(): number { throw new Error("deep"); }
      export function test(x: number): number {
        try {
          if (x > 0) {
            return boom();
          }
          return -1;
        } catch (e) {
          return 99;
        }
      }
    `;
    expect(await run(src, "test", [1])).toBe(99);
    expect(await run(src, "test", [0])).toBe(-1);
  });

  it("try/finally without catch: finally runs, value returned", async () => {
    const src = `
      let log = 0;
      function val(): number { return 5; }
      export function test(): number {
        try { return val(); } finally { log = 1; }
      }
      export function getLog(): number { return log; }
    `;
    const instance = await instantiate(await compileSrc(src));
    expect((instance.exports as any).test()).toBe(5);
    expect((instance.exports as any).getLog()).toBe(1);
  });
});
