// #1941 — Differential test of `--optimize` (Binaryen wasm-opt) output.
//
// The equivalence suite and diff-test corpus historically compiled with
// DEFAULT options only, so optimized output was never executed by any gate.
// A wasm-opt miscompile shipped invisibly (the binaryen-123 JS module emits a
// stale GC ref-type encoding for our closure-dispatch trampolines that V8 and
// wasmtime reject — see plan/issues/1941-...).
//
// This test asserts the two correctness properties of `optimize: true`:
//   1. Optimized output ALWAYS passes `WebAssembly.validate` (we never ship a
//      binary that doesn't validate; src/optimize.ts gates on this).
//   2. Optimized output produces IDENTICAL observable results to unoptimized
//      output for a representative set of programs — including the exact
//      closure-trampoline shape that triggered #1941.
//
// It runs in the cheap `quality` CI job (no extra shard). When no wasm-opt
// backend is available the optimize pass is a graceful no-op (returns the
// original binary with a warning), so the equality assertions still hold by
// construction and the test stays green.

import { describe, it, expect, vi } from "vitest";
import { compile } from "../../src/index.js";
import { buildCompiledImports } from "../../src/runtime.js";

/** Compile + instantiate, capturing console output, with or without optimize. */
async function runProgram(source: string, optimize: boolean): Promise<{ output: string[]; validated: boolean }> {
  // (#6979) Compiled under the native regime (the only profile); console output
  // is captured from the runtime's own console bindings, which marshal native
  // strings to JS before they reach `console.log`.
  const result = await compile(source, optimize ? { optimize: true } : {});
  expect(result.success, `compile failed: ${result.errors.map((e) => e.message).join("; ")}`).toBe(true);

  // Property 1: optimized output must always validate. (Unoptimized output is
  // the codegen baseline; if it somehow doesn't validate that's a different
  // bug and instantiate below will surface it.)
  const validated = WebAssembly.validate(result.binary);

  const output: string[] = [];
  // The real runtime import object (the equivalence helper stubs console out).
  const imports = buildCompiledImports(result);
  // Capture console output so we compare side effects.
  const spy = vi
    .spyOn(console, "log")
    .mockImplementation((...args: unknown[]) => void output.push(args.map(String).join(" ")));
  try {
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    (imports as { setInstance?: (i: WebAssembly.Instance) => void }).setInstance?.(instance);
    // Invoke an exported `main` if present (top-level side effects already ran
    // during instantiation via the start section).
    const main = (instance.exports as Record<string, unknown>).main;
    if (typeof main === "function") (main as () => void)();
  } finally {
    spy.mockRestore();
  }

  return { output, validated };
}

/**
 * Representative programs. `closure-trampoline` is the exact #1941 repro
 * (`tests/differential/corpus/closures/01-basic.js`): a curried adder whose
 * `__call_fn_1` dispatch trampoline is what the buggy binaryen module
 * miscompiled. The others exercise other codegen shapes wasm-opt touches.
 */
const PROGRAMS: { name: string; source: string }[] = [
  {
    name: "closure-trampoline (#1941 repro)",
    source: `
      function makeAdder(n: number) {
        return function (x: number) {
          return x + n;
        };
      }
      const add5 = makeAdder(5);
      export function main(): void {
        console.log(add5(3));
        console.log(add5(10));
      }
    `,
  },
  {
    name: "recursive fib",
    source: `
      export function fib(n: number): number {
        if (n <= 1) return n;
        return fib(n - 1) + fib(n - 2);
      }
      export function main(): void {
        console.log(fib(10));
      }
    `,
  },
  {
    name: "loop + arithmetic",
    source: `
      export function main(): void {
        let total = 0;
        for (let i = 0; i < 20; i++) {
          total += i * 2;
        }
        console.log(total);
      }
    `,
  },
  {
    name: "higher-order map-like",
    source: `
      function applyTwice(f: (x: number) => number, v: number): number {
        return f(f(v));
      }
      export function main(): void {
        console.log(applyTwice((x) => x + 1, 10));
        console.log(applyTwice((x) => x * 3, 2));
      }
    `,
  },
];

describe("--optimize differential (#1941)", () => {
  for (const { name, source } of PROGRAMS) {
    it(`${name}: optimized output validates and matches unoptimized`, async () => {
      const unopt = await runProgram(source, false);
      const opt = await runProgram(source, true);

      // Property 1: optimized binary always validates.
      expect(opt.validated, "optimized binary failed WebAssembly.validate").toBe(true);

      // Property 2: optimized observable output is identical to unoptimized.
      expect(opt.output).toEqual(unopt.output);
      // Non-vacuity: every program logs, so an empty capture is a harness defect.
      expect(unopt.output.length).toBeGreaterThan(0);
    });
  }
});
