// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #4616 (jest diff-sequences) — `ctx.closureMap` is keyed by BARE NAME across
// the whole linked module graph. A test file's local `const foundSubsequence =
// () => {}` registered a 0-arity ClosureInfo under that name; the UNRELATED
// 3-arity function PARAMETER `foundSubsequence` in diff-sequences then
// resolved to it by name, compiled its calls as single-candidate 0-arg
// call_ref, and the guarded funcref cast nulled for every real callback →
// un-catchable "dereferencing a null pointer" (32 of 48 diff-sequences tests).
// Parameters and destructured bindings never register in closureMap, so a
// by-name hit for them is always leakage — they must use the typed
// callable-param dispatch instead.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

async function run(source: string) {
  const result = await compile(source, {
    testRuntime: true,
    fileName: "issue-4616-leak.ts",
    skipSemanticDiagnostics: true,
  });
  expect(result.success).toBe(true);
  const importObject = (result as { importObject?: WebAssembly.Imports }).importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary!, importObject);
  (importObject as { __setInstance?: (i: WebAssembly.Instance) => void }).__setInstance?.(instance);
  return wrapExports(instance, {
    signatures: (result as { exportSignatures?: unknown }).exportSignatures,
  }) as Record<string, (...args: unknown[]) => unknown>;
}

describe("#4616 closureMap bare-name leakage", () => {
  it("a 3-arity param is not hijacked by a same-named 0-arity local arrow", async () => {
    const exp = await run(`
      type Found = (a: number, b: number, c: number) => void;
      let sum = 0;
      function driver(found: Found): void {
        found(1, 2, 3);
        found(10, 20, 30);
      }
      export function useNoop(): number {
        // Registers a 0-arity ClosureInfo under the bare name "found".
        const found = () => { sum += 1000; };
        found();
        return sum;
      }
      export function t(): number {
        sum = 0;
        driver((a: number, b: number, c: number) => { sum += a + b + c; });
        return sum;
      }`);
    expect(exp.t!()).toBe(66);
  });

  it("a destructured const is not hijacked by a same-named local arrow", async () => {
    const exp = await run(`
      type Found = (a: number, b: number, c: number) => void;
      let sum = 0;
      export function useNoop(): void {
        const found = () => { sum += 1000; };
        found();
      }
      export function t(): number {
        sum = 0;
        const callbacks = { found: (a: number, b: number, c: number) => { sum += a + b + c; } };
        const { found } = callbacks;
        found(4, 5, 6);
        return sum;
      }`);
    expect(exp.t!()).toBe(15);
  });
});
