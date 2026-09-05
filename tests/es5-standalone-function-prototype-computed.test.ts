// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function run(source: string): Promise<number> {
  const result = await compile(source, { target: "standalone" });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { test: () => number }).test();
}

describe("ES5 computed Function.prototype read", () => {
  it("reports Function['prototype'] as callable", async () => {
    expect(
      await run(`const overlayProbe = [1];
      Object.defineProperty(overlayProbe, "0", { value: 1 });
      export function test(): number {
        return typeof Function["prototype"] === "function" ? 1 : 0;
      }`),
    ).toBe(1);
    expect(
      await run(`const overlayProbe = [1];
      Object.defineProperty(overlayProbe, "0", { value: 1 });
      export function test(): number {
        return typeof Function["prototype"] !== "function" ? 1 : 0;
      }`),
    ).toBe(0);
  });

  it("classifies computed prototype metadata and method values", async () => {
    expect(
      await run(`export function test(): number {
        return typeof Function.prototype["length"] === "number" &&
          typeof Function.prototype["toString"] === "function" &&
          typeof Function.prototype["valueOf"] === "function" ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("does not claim a locally shadowed Function binding", async () => {
    expect(
      await run(`export function test(): number {
        const Function = { prototype: { length: "local" } };
        return typeof Function["prototype"] === "object" &&
          typeof Function.prototype["length"] === "string" ? 1 : 0;
      }`),
    ).toBe(1);
  });
});
