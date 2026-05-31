// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Tests for #1568 — Object(BigInt) auto-boxing (§7.1.18 ToObject, Table 13).
 *
 * PR #460 (#1129) added Object(primitive) boxing for number/string/boolean but
 * not BigInt. Object(bigint) previously fell through the "Object(object) →
 * return unchanged" branch, so `typeof Object(0n)` was "bigint" instead of
 * "object". This adds a BigInt branch to the Object(x) switch + a __new_BigInt
 * host handler that boxes via the spec's literal Object(v) (BigInt is not a
 * constructor, so `new BigInt(v)` throws).
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

describe("#1568 — Object(BigInt) auto-boxing", () => {
  it("typeof Object(0n) === 'object'", async () => {
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

  it("typeof Object(BigInt(0n)) === 'object' (test262 assertion #4)", async () => {
    const r = await run(`export function test(): number {
      return typeof Object(BigInt(0n)) === "object" ? 1 : 0;
    }`);
    expect(r).toBe(1);
  });

  it("bare bigint literal stays typeof 'bigint' (no over-boxing)", async () => {
    const r = await run(`export function test(): number {
      const x = 0n;
      return typeof x === "bigint" ? 1 : 0;
    }`);
    expect(r).toBe(1);
  });

  it("regression: Object(number) still boxes to object", async () => {
    const r = await run(`export function test(): number {
      return typeof Object(42) === "object" ? 1 : 0;
    }`);
    expect(r).toBe(1);
  });

  it("regression: Object(boolean) still boxes to object", async () => {
    const r = await run(`export function test(): number {
      return typeof Object(true) === "object" ? 1 : 0;
    }`);
    expect(r).toBe(1);
  });
});
