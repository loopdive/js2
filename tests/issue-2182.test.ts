// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2182 — detached-array funcIdx-shift hazard: completeness hardening.
//
// #1257 fixed the observable funcIdx-shift corruption (a detached instruction
// array held across a late import, whose `call` funcIdxs got over-shifted). This
// is the deferred completeness half: a balance assertion in `compileFunctionBody`
// (every `liveBodies.add` must be matched by a `.delete`), `liveBodies`
// registration of the remaining raw `const saved = fctx.body` body-swaps
// (builtin-static-globals, type-coercion toString dispatch, native-generator
// resume-state build), and this stress test.
//
// The stress test compiles fixtures that trigger MANY late imports during deeply
// nested detached-array compilation (nested destructuring with defaults that call
// host builtins, generators, loop conditions) and asserts the module both
// compiles AND runs to the expected value — i.e. every `call` funcIdx still
// resolves to the intended function after all the late-import shifts.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runFn<T = unknown>(src: string, fnName: string, ...args: number[]): Promise<T> {
  const r = await compile(src, { fileName: "test.ts" });
  if (!r.success) {
    throw new Error(`compile failed:\n${r.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const imps = buildImports(r.imports as never, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imps as never);
  if (typeof (imps as { setExports?: (e: unknown) => void }).setExports === "function") {
    (imps as { setExports: (e: unknown) => void }).setExports(instance.exports);
  }
  return (instance.exports as Record<string, (...a: number[]) => T>)[fnName](...args);
}

describe("#2182 detached-body funcIdx-shift hazard — stress + balance", () => {
  it("nested destructuring defaults calling host builtins (many late imports) resolve correctly", async () => {
    // Each `Math.*` default in the destructuring pattern is a late import fired
    // while the destructuring buffers are detached. If a funcIdx over-shifted,
    // one of these calls would resolve to the wrong function and the result
    // would diverge from the expected sum.
    const src = `
      export function f(): number {
        const { a = Math.floor(3.7), b = Math.ceil(2.1), c = Math.abs(-4), d = Math.max(5, 1) } =
          {} as { a?: number; b?: number; c?: number; d?: number };
        const { e = Math.min(9, 6), g = Math.round(7.4), h = Math.sqrt(16) } =
          {} as { e?: number; g?: number; h?: number };
        return a + b + c + d + e + g + h;
      }`;
    // 3 + 3 + 4 + 5 + 6 + 7 + 4 = 32
    expect(await runFn<number>(src, "f")).toBe(32);
  });

  it("generator with builtin calls in body (resume-state detached build) resolves correctly", async () => {
    const src = `
      export function f(): number {
        function* gen(): Generator<number> {
          yield Math.floor(1.9);
          yield Math.abs(-2);
          yield Math.max(3, 0);
        }
        let total = 0;
        for (const v of gen()) { total = total + v; }
        return total;
      }`;
    // 1 + 2 + 3 = 6
    expect(await runFn<number>(src, "f")).toBe(6);
  });

  it("many interleaved string + numeric builtin late imports keep call targets intact", async () => {
    const src = `
      export function f(): number {
        let s = "";
        let n = 0;
        for (let i = 0; i < 5; i = i + 1) {
          s = s + "x";
          n = n + Math.floor(i + 0.5);
        }
        // s.length exercises a late string import; n sums the floor results.
        return s.length + n;
      }`;
    // s.length = 5; n = 0+1+2+3+4 = 10 → 15
    expect(await runFn<number>(src, "f")).toBe(15);
  });

  it("deeply nested loop + destructuring-default builtins (compound late-import nesting)", async () => {
    const src = `
      export function f(): number {
        let acc = 0;
        for (let i = 0; i < 3; i = i + 1) {
          const { p = Math.abs(-1), q = Math.floor(2.5) } = {} as { p?: number; q?: number };
          let j = 2;
          while (j) {
            acc = acc + p + q;
            j = j - 1;
          }
        }
        return acc;
      }`;
    // per outer iter: (1+2) added twice = 6; ×3 = 18
    expect(await runFn<number>(src, "f")).toBe(18);
  });

  it("balance assertion does not false-positive on closures + builtins", async () => {
    // A lifted closure capturing a local, plus a builtin late import, exercises
    // the liveBodies add/delete discipline across function boundaries; this must
    // compile cleanly (no #2182 invariant throw) and run correctly.
    const src = `
      export function f(): number {
        let base = Math.floor(9.5);
        const add = (x: number): number => x + base;
        return add(Math.abs(-2));
      }`;
    // base = 9, add(2) = 2 + 9 = 11
    expect(await runFn<number>(src, "f")).toBe(11);
  });
});
