// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// ES5 String.prototype.substring reflective generic-receiver residual.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function run(source: string): Promise<number> {
  const result = await compile(source, {
    target: "standalone",
    skipSemanticDiagnostics: true,
  });
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  expect(result.imports ?? []).toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, result.importObject ?? {});
  return (instance.exports as { test(): number }).test();
}

describe("#2742 String.prototype.substring reflective generic receiver", () => {
  it("supports a direct reflective call", async () => {
    expect(
      await run(`export function test(): number {
        const value: any = String.prototype.substring.call({}, 8, 0);
        return value === "[object " ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("stringifies an array receiver and coerces string bounds", async () => {
    expect(
      await run(`export function test(): number {
        const value: any = [1, 2, 3, 4, 5];
        value.substring = String.prototype.substring;
        return value.substring("4", "5") === "3" ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("defaults an omitted end bound to the string length", async () => {
    expect(
      await run(`export function test(): number {
        const value: any = new Boolean(false);
        value.substring = String.prototype.substring;
        return value.substring(true) === "alse" ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("preserves substring's swapped-bound behavior", async () => {
    expect(
      await run(`export function test(): number {
        const value: any = {};
        value.substring = String.prototype.substring;
        return value.substring(8, 0) === "[object " ? 1 : 0;
      }`),
    ).toBe(1);
  });
});
