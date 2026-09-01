// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

async function runStandalone(source: string, platform?: "web" | "node" | "deno"): Promise<number> {
  const result = await compile(source, {
    target: "standalone",
    ...(platform === undefined ? {} : { platform }),
    fileName: "es5-regression-platform-carrier.ts",
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  const exports = instance.exports as WebAssembly.Exports & { __module_init?: () => void; test: () => number };
  exports.__module_init?.();
  return exports.test();
}

describe("ES5 standalone regression recovery", () => {
  it("only seeds Deno's extra primordial globals for the Deno platform", async () => {
    const source = `
      export function test(): number {
        const key = "AggregateError";
        return Object.prototype.hasOwnProperty.call(globalThis, key) ? 1 : 0;
      }
    `;

    await expect(runStandalone(source, "deno")).resolves.toBe(1);
    await expect(runStandalone(source, "web")).resolves.toBe(0);
    await expect(runStandalone(source)).resolves.toBe(0);
  });

  it("preserves undefined fields in nested object-literal carriers", async () => {
    const source = `
      const { w: { x, y, z } = { x: 4, y: 5, z: 6 } } = { w: { x: undefined, z: 7 } };
      export function test(): number {
        return x === undefined && y === undefined && z === 7 ? 1 : 0;
      }
    `;

    await expect(runStandalone(source)).resolves.toBe(1);
  });

  it("uses the last duplicate nested object-literal property", async () => {
    const source = `
      const { w: { y } } = { w: { x: 1 }, w: { y: 2 } };
      export function test(): number { return y === 2 ? 1 : 0; }
    `;

    await expect(runStandalone(source)).resolves.toBe(1);
  });
});
