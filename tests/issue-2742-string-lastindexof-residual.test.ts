// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// ES5 String.prototype.lastIndexOf position coercion residual.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function run(source: string, target?: "standalone"): Promise<number> {
  const result = await compile(source, {
    target,
    skipSemanticDiagnostics: true,
  });
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  if (target === "standalone") {
    expect(result.imports ?? []).toEqual([]);
  }
  const imports = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  const setExports = (imports as { __setExports?: (exports: WebAssembly.Exports) => void }).__setExports;
  if (setExports) setExports(instance.exports);
  return (instance.exports as { test(): number }).test();
}

describe("#2742 String.prototype.lastIndexOf standalone position coercion", () => {
  const nanPositionSource = `export function test(): number {
    const search = { toString: function () { return "AB"; } };
    const position = { valueOf: function () { return NaN; } };
    return "ABBABABAB".lastIndexOf(search, position);
  }`;

  it("keeps the existing JS-host object-to-NaN behavior", async () => {
    expect(await run(nanPositionSource)).toBe(7);
  });

  it("searches from the end for an object-to-NaN position in standalone", async () => {
    expect(await run(nanPositionSource, "standalone")).toBe(7);
  });

  it("searches from the end when OrdinaryToPrimitive produces undefined", async () => {
    expect(
      await run(
        `export function test(): number {
          const position = { valueOf: function () { return {}; }, toString: function () {} };
          return "ABBABABAB".lastIndexOf("AB", position);
        }`,
        "standalone",
      ),
    ).toBe(7);
  });

  it("does not change indexOf's NaN-to-zero position rule", async () => {
    expect(
      await run(
        `export function test(): number {
          const position = { valueOf: function () { return NaN; } };
          return "ABBABABAB".indexOf("AB", position);
        }`,
        "standalone",
      ),
    ).toBe(0);
  });
});
