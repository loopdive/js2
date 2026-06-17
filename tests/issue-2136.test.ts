// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2136 — numeric-truthiness loop conditions should CLAIM through IR, not demote.
//
// #1980 fixed the correctness bug (an f64 `while (k)` cond reached the lowerer's
// unconditional `i32.eqz` and emitted invalid Wasm) by *bailing to legacy* — it
// threw "condition must be bool", which left every numeric-truthiness loop
// permanently in the post-claim fallback bucket. #2136 instead lowers a non-i32
// loop condition through ToBoolean (`abs(x) > 0`, NaN-safe — matches #1937 and
// the linear backend's emitTruthyCoercion) inside the cond buffer, so the loop
// claims and runs correctly on the IR path.
//
// These tests assert BOTH that (a) the loop produces the correct value and
// (b) the compile no longer records a "condition must be bool" post-claim
// demotion (i.e. the function stayed on the IR path).

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

interface IrResult {
  value: unknown;
  loopBailed: boolean;
}

async function runIr(src: string, arg: number): Promise<IrResult> {
  const r = (await compile(src, { fileName: "test.ts", experimentalIR: true })) as Awaited<
    ReturnType<typeof compile>
  > & { irPostClaimErrors?: { kind: string; func: string; message: string }[] };
  if (!r.success) {
    throw new Error(`compile failed:\n${r.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const loopBailed = (r.irPostClaimErrors ?? []).some((e) => /condition must be bool/.test(e.message));
  const imps = buildImports(r.imports as never, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imps as never);
  if (typeof (imps as { setExports?: (e: unknown) => void }).setExports === "function") {
    (imps as { setExports: (e: unknown) => void }).setExports(instance.exports);
  }
  return { value: (instance.exports as { f: (n: number) => unknown }).f(arg), loopBailed };
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

const whileCmp = `export function f(n: number): number {
  let s = 0; let k = n;
  while (k > 0) { s = s + k; k = k - 1; }
  return s;
}`;

describe("#2136 numeric-truthiness loops claim through IR", () => {
  it("while (k) sums n..1 AND stays on the IR path", async () => {
    const { value, loopBailed } = await runIr(whileTruthy, 4);
    expect(value).toBe(10); // 4+3+2+1
    expect(loopBailed).toBe(false);
  });

  it("while (k) terminates immediately when k is 0 (falsy)", async () => {
    const { value, loopBailed } = await runIr(whileTruthy, 0);
    expect(value).toBe(0);
    expect(loopBailed).toBe(false);
  });

  it("for (; k; ) sums n..1 AND stays on the IR path", async () => {
    const { value, loopBailed } = await runIr(forTruthy, 3);
    expect(value).toBe(6); // 3+2+1
    expect(loopBailed).toBe(false);
  });

  it("NaN condition is falsy — loop body never runs", async () => {
    const src = `export function f(n: number): number {
      let k = 0 / 0; let s = 7;
      while (k) { s = s + 1; }
      return s;
    }`;
    const { value, loopBailed } = await runIr(src, 0);
    expect(value).toBe(7);
    expect(loopBailed).toBe(false);
  });

  it("does not regress an i32-comparison while loop (still claims, no coercion needed)", async () => {
    const { value, loopBailed } = await runIr(whileCmp, 4);
    expect(value).toBe(10);
    expect(loopBailed).toBe(false);
  });
});
