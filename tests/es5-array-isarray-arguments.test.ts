// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// ES5 §15.4.3.2 — an arguments object is array-like, but IsArray must reject
// it. The standalone lowering keeps arguments on a nominal vec subtype so the
// ordinary vec indexed/length machinery remains shared without conflating the
// two brands.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

async function run(source: string): Promise<number> {
  const result = await compile(source, {
    target: "standalone",
    fileName: "es5-array-isarray-arguments.ts",
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary), "module failed WebAssembly.validate").toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { test: () => number }).test();
}

describe("ES5 Array.isArray(arguments) in standalone", () => {
  it("rejects arguments while preserving its indexed and length values", async () => {
    await expect(
      run(`
        let observed = 0;
        (function probe(a: number, b: number): void {
          observed = (Array.isArray(arguments) ? 100 : 0) + arguments.length * 10 + arguments[1];
        })(3, 7);
        export function test(): number { return observed; }
      `),
    ).resolves.toBe(27);
  });

  it("keeps the brand on a zero-formal arguments object", async () => {
    await expect(
      run(`
        let observed = 0;
        (function probe(): void {
          observed = Array.isArray(arguments) ? 1 : 0;
        })(1, 2, 3);
        export function test(): number { return observed; }
      `),
    ).resolves.toBe(0);
  });

  it("continues to identify ordinary arrays", async () => {
    await expect(
      run(`
        const values = [1, 2, 3];
        export function test(): number { return Array.isArray(values) ? 1 : 0; }
      `),
    ).resolves.toBe(1);
  });
});
