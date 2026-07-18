// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Tests for #2728 — `Object(Symbol())` should box to a Symbol-wrapper object
 * (§7.1.18 ToObject, Table 13), whose `typeof` is "object".
 *
 * Split out of #1846 (descoped). This was the single remaining failing
 * assertion in test262 `language/expressions/typeof/symbol.js` (#3/#4:
 * `typeof Object(Symbol()) === "object"`). The bare `typeof Symbol()` cases
 * already pass.
 *
 * Fix: `tryObjectCoercionCall` (`src/codegen/expressions/calls-guards.ts`) now
 * has a Symbol branch (mirroring Number/String/Boolean/BigInt) that lowers to a
 * dedicated `__new_Symbol(i32) -> externref` host helper. Symbol is NOT a
 * constructor, so — like `__new_BigInt` (#1568) / AggregateError — the import is
 * routed through the dedicated runtime `builtin` handler
 * (`src/compiler/import-manifest.ts`) instead of the generic `extern_class`
 * `new Symbol(id)` path (which throws). The handler boxes the i32 symbol id to
 * the real JS Symbol via the same per-instance id→Symbol cache as `__box_symbol`
 * and returns `Object(sym)`.
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

describe("#2728 — Object(Symbol()) → Symbol-wrapper object", () => {
  it("typeof Object(Symbol()) === 'object' (test262 symbol.js #3)", async () => {
    const r = await run(`export function test(): number {
      return typeof Object(Symbol()) === "object" ? 1 : 0;
    }`);
    expect(r).toBe(1);
  });

  it("typeof Object(Symbol('A')) === 'object' (test262 symbol.js #4)", async () => {
    const r = await run(`export function test(): number {
      return typeof Object(Symbol("A")) === "object" ? 1 : 0;
    }`);
    expect(r).toBe(1);
  });

  it("bare typeof Symbol() stays 'symbol' (no over-boxing)", async () => {
    const r = await run(`export function test(): number {
      return typeof Symbol() === "symbol" ? 1 : 0;
    }`);
    expect(r).toBe(1);
  });

  it("Symbol-wrapper preserves the description", async () => {
    const r = await run(`export function test(): string {
      const w: any = Object(Symbol("hi"));
      return w.description;
    }`);
    expect(r).toBe("hi");
  });

  it("Symbol-wrapper object is truthy (ToBoolean)", async () => {
    const r = await run(`export function test(): number {
      return Object(Symbol()) ? 1 : 0;
    }`);
    expect(r).toBe(1);
  });

  it("regression: Object(number) still boxes to object", async () => {
    const r = await run(`export function test(): number {
      return typeof Object(42) === "object" ? 1 : 0;
    }`);
    expect(r).toBe(1);
  });

  it("regression: Object(string) still boxes to object", async () => {
    const r = await run(`export function test(): number {
      return typeof Object("s") === "object" ? 1 : 0;
    }`);
    expect(r).toBe(1);
  });

  it("regression: Object(boolean) still boxes to object", async () => {
    const r = await run(`export function test(): number {
      return typeof Object(true) === "object" ? 1 : 0;
    }`);
    expect(r).toBe(1);
  });

  it("regression: Object({}) returns the object unchanged (typeof object)", async () => {
    const r = await run(`export function test(): number {
      const o = { a: 1 };
      return typeof Object(o) === "object" ? 1 : 0;
    }`);
    expect(r).toBe(1);
  });
});
