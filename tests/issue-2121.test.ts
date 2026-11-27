// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2121 — parameter-default TDZ was not enforced.
//
// Per §10.2.11 FunctionDeclarationInstantiation, parameter bindings are
// initialized left-to-right, so a default value that reads its own parameter or
// a *later* one observes that binding in the TDZ and must throw ReferenceError.
// The lowering read the (zero-/undefined-initialized) local directly, so
// `f(a = a)` returned NaN and `f(a = b, b = 2)` read the later binding.
//
// Fix: when a parameter default references itself or a later parameter, emit a
// ReferenceError throw in the "default fires" branch instead of the read.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { instantiateWithRuntime } from "./equivalence/helpers.js";

// Run a body that wraps the call in try/catch and reports whether a
// ReferenceError was thrown — the compiled error model carries a real
// ReferenceError instance, observable via the in-language `instanceof`.
async function run(src: string, fn: string): Promise<number | string> {
  const r = await compile(src, { fileName: "test.ts", skipDiagnostics: true });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const instance = await instantiateWithRuntime(r);
  return (instance.exports as Record<string, () => number | string>)[fn]!();
}

describe("#2121 parameter-default TDZ throws on self/forward reference", () => {
  it("self-referencing default throws ReferenceError", async () => {
    const src = `
function f(a: number = a): number { return a; }
export function test(): string {
  try { f(); return "no-throw"; } catch (e) { return e instanceof ReferenceError ? "RE" : "other"; }
}`;
    expect(await run(src, "test")).toBe("RE");
  });

  it("forward-referencing default throws ReferenceError", async () => {
    const src = `
function f(a: any = b, b: any = 2): string { return "" + a + b; }
export function test(): string {
  try { f(); return "no-throw"; } catch (e) { return e instanceof ReferenceError ? "RE" : "other"; }
}`;
    expect(await run(src, "test")).toBe("RE");
  });

  it("string-typed self-referencing default throws", async () => {
    const src = `
function f(a: string = a): string { return a; }
export function test(): string {
  try { f(); return "no-throw"; } catch (e) { return e instanceof ReferenceError ? "RE" : "other"; }
}`;
    expect(await run(src, "test")).toBe("RE");
  });

  it("default does not fire when the argument is provided (no throw)", async () => {
    const src = `
function f(a: number = a): number { return a; }
export function test(): number { return f(9); }`;
    expect(await run(src, "test")).toBe(9);
  });

  it("referencing a strictly-earlier parameter stays valid", async () => {
    const src = `
function g(a: number, b: number = a): number { return a + b; }
export function test(): number { return g(3); }`;
    expect(await run(src, "test")).toBe(6);
  });

  it("chained left-to-right defaults stay valid", async () => {
    const src = `
function f(a: number = 1, b: number = a + 1): number { return a + b; }
export function test(): number { return f(); }`;
    expect(await run(src, "test")).toBe(3); // a=1, b=2
  });
});
