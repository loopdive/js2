// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #4739 — standalone Function.prototype @@hasInstance value and descriptor.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(body: string): Promise<number> {
  const result = await compile(`export function test(): number { ${body} }`, {
    allowJs: true,
    fileName: "issue-4739-function-hasinstance-descriptor.ts",
    skipSemanticDiagnostics: true,
    target: "standalone",
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary), "module failed WebAssembly.validate").toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { test(): number }).test();
}

describe("#4739 standalone Function.prototype @@hasInstance descriptor", () => {
  it("exposes the native method and its exact non-writable descriptor", async () => {
    await expect(
      runStandalone(`
        const descriptor = Object.getOwnPropertyDescriptor(Function.prototype, Symbol.hasInstance);
        return typeof Function.prototype[Symbol.hasInstance] === "function" &&
          descriptor !== undefined &&
          descriptor.value === Function.prototype[Symbol.hasInstance] &&
          descriptor.writable === false &&
          descriptor.enumerable === false &&
          descriptor.configurable === false ? 1 : 0;
      `),
    ).resolves.toBe(1);
  });

  it("ignores unrelated prototype setup in the source when resolving the intrinsic", async () => {
    await expect(
      runStandalone(`
        function HarnessError() {}
        HarnessError.prototype.toString = function () { return "error"; };
        const descriptor = Object.getOwnPropertyDescriptor(Function.prototype, Symbol.hasInstance);
        return typeof Function.prototype[Symbol.hasInstance] === "function" &&
          descriptor !== undefined && descriptor.writable === false ? 1 : 0;
      `),
    ).resolves.toBe(1);
  });
});
