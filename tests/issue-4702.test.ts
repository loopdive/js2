// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #4702 — callable closures stored in an initially undefined externref array.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runJs(source: string): Promise<unknown> {
  const result = await compile(source, {
    allowJs: true,
    fileName: "issue-4702.js",
    skipSemanticDiagnostics: true,
  });
  if (!result.success) {
    throw new Error(`compile failed: ${result.errors.map((error) => error.message).join("; ")}`);
  }
  expect(WebAssembly.validate(result.binary), "module failed WebAssembly.validate").toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setExports?.(instance.exports as Record<string, Function>);
  return (instance.exports as { test: () => unknown }).test();
}

describe("#4702 — for-of fresh-binding closure arrays", () => {
  it("const head keeps one closure value per iteration", async () => {
    await expect(
      runJs(`
        export function test() {
          let s = 0;
          let f = [undefined, undefined, undefined];
          for (const x of [1, 2, 3]) {
            s += x;
            f[x - 1] = function() { return x; };
          }
          return s === 6 && f[0]() === 1 && f[1]() === 2 && f[2]() === 3 ? 1 : 0;
        }
      `),
    ).resolves.toBe(1);
  });

  it("let head keeps one closure value per iteration", async () => {
    await expect(
      runJs(`
        export function test() {
          let s = 0;
          let f = [undefined, undefined, undefined];
          for (let x of [1, 2, 3]) {
            s += x;
            f[x - 1] = function() { return x; };
          }
          return s === 6 && f[0]() === 1 && f[1]() === 2 && f[2]() === 3 ? 1 : 0;
        }
      `),
    ).resolves.toBe(1);
  });

  it("keeps TypeError for an actually undefined externref element", async () => {
    await expect(
      runJs(`
        export function test() {
          const f = [undefined];
          try {
            f[0]();
            return 0;
          } catch (error) {
            return error instanceof TypeError ? 1 : 0;
          }
        }
      `),
    ).resolves.toBe(1);
  });

  it("does not route numeric array elements through dynamic closure dispatch", async () => {
    await expect(
      runJs(`
        export function test() {
          const values = [1];
          try {
            values[0]();
            return 0;
          } catch (error) {
            return error instanceof TypeError ? 1 : 0;
          }
        }
      `),
    ).resolves.toBe(1);
  });
});
