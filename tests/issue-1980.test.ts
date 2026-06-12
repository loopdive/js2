// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1980 — IR `while`/`for` lowering skipped the i32-bool check that `if` and
// ternary apply, so a numeric-truthiness loop condition (`while (k)` with an
// f64 `k`) reached the lowerer's unconditional `i32.eqz` and emitted invalid
// Wasm — `i32.eqz expected type i32, found local.get of type f64` — which
// bricked the *entire module* (no fallback, verifier silent).
//
// Fix: `lowerWhileStatement` / `lowerForStatement` now (a) capture the value id
// `lowerExpr` returns instead of the cond buffer's last instruction result, and
// (b) throw the same "condition must be bool" fallback as `if`/ternary when the
// cond isn't already i32 — restoring the legacy path for numeric-truthiness
// loops. The IR verifier also gained an i32 check on `while.loop`/`for.loop`
// condValue as the structural backstop (#1850 gap).

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(src: string, arg: number): Promise<unknown> {
  const r = await compile(src, { fileName: "test.ts" });
  if (!r.success) {
    throw new Error(`compile failed:\n${r.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const imps = buildImports(r.imports as never, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imps as never);
  if (typeof (imps as { setExports?: Function }).setExports === "function") {
    (imps as { setExports: Function }).setExports(instance.exports);
  }
  return (instance.exports as { f: (n: number) => unknown }).f(arg);
}

const whileTruthy = `export function f(n: number): number {
  let s = 0; let k = n;
  while (k) { s = s + k; k = k - 1; }
  return s;
}`;

const forTruthy = `export function f(n: number): number {
  let s = 0;
  for (let k = n; k; k = k - 1) { s = s + k; }
  return s;
}`;

describe("#1980 numeric-truthiness loop condition", () => {
  it("while (k) with an f64 counter sums n..1 (was: invalid Wasm)", async () => {
    expect(await run(whileTruthy, 3)).toBe(6); // node: 3+2+1
    expect(await run(whileTruthy, 5)).toBe(15); // node: 5+4+3+2+1
  });

  it("while (k) terminates immediately when n is 0", async () => {
    expect(await run(whileTruthy, 0)).toBe(0); // node: 0
  });

  it("for (; k; ) with an f64 counter sums n..1", async () => {
    expect(await run(forTruthy, 3)).toBe(6); // node: 3+2+1
    expect(await run(forTruthy, 0)).toBe(0); // node: 0
  });

  it("does not regress an i32-comparison for loop (IR path)", async () => {
    const src = `export function f(n: number): number {
      let s = 0;
      for (let i = 0; i < n; i = i + 1) { s = s + i; }
      return s;
    }`;
    expect(await run(src, 4)).toBe(6); // node: 0+1+2+3
  });

  it("does not regress an i32-comparison while loop (IR path)", async () => {
    const src = `export function f(n: number): number {
      let s = 0; let i = 0;
      while (i < n) { s = s + i; i = i + 1; }
      return s;
    }`;
    expect(await run(src, 4)).toBe(6); // node: 0+1+2+3
  });
});
