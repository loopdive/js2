// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3377 — `Object(bigint)` regressed to throwing "No dependency provided for
 * extern class BigInt" instead of returning a BigInt-wrapper object
 * (§7.1.18 ToObject, Table 13; `typeof` → "object"). Regression of #1568.
 *
 * Root cause: `__new_BigInt` had no dedicated route in `import-manifest.ts`, so
 * it fell through to the generic `extern_class` `new BigInt(v)` path — which
 * finds no `BigInt` in the runtime's `builtinCtors` (correctly: BigInt is not a
 * constructor) and throws. Fix routes it through a dedicated runtime `builtin`
 * handler that boxes via the spec's literal `Object(v)` (mirrors #2728's
 * `__new_Symbol`).
 *
 * `tests/issue-1568.test.ts` is the primary coverage; this adds a focused guard
 * so the regression can't silently return without a dedicated failing row.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(source: string): Promise<unknown> {
  const r = await compile(source, { fileName: "test.ts" });
  if (!r.success) {
    throw new Error(`compile failed: ${r.errors[0]?.message ?? "unknown"}`);
  }
  const built = buildImports(r.imports, {}, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, built as WebAssembly.Imports);
  if (built.setExports) built.setExports(instance.exports as Record<string, Function>);
  return (instance.exports as Record<string, () => unknown>).test();
}

describe("#3377 — Object(bigint) boxes to a BigInt-wrapper object", () => {
  it("typeof Object(0n) === 'object' (does not throw)", async () => {
    const r = await run(`export function test(): number {
      return typeof Object(0n) === "object" ? 1 : 0;
    }`);
    expect(r).toBe(1);
  });

  it("typeof Object(BigInt(42)) === 'object'", async () => {
    const r = await run(`export function test(): number {
      return typeof Object(BigInt(42)) === "object" ? 1 : 0;
    }`);
    expect(r).toBe(1);
  });

  it("bare typeof 0n stays 'bigint' (no over-boxing)", async () => {
    const r = await run(`export function test(): number {
      const x = 0n;
      return typeof x === "bigint" ? 1 : 0;
    }`);
    expect(r).toBe(1);
  });

  it("Object(bigint) wrapper is truthy (ToBoolean — even for 0n)", async () => {
    const r = await run(`export function test(): number {
      return Object(0n) ? 1 : 0;
    }`);
    expect(r).toBe(1);
  });

  it("regression: Object(number) still boxes to object", async () => {
    const r = await run(`export function test(): number {
      return typeof Object(42) === "object" ? 1 : 0;
    }`);
    expect(r).toBe(1);
  });
});
