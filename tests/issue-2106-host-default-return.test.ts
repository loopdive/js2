// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #2106 — JS-host externref returns must preserve undefined rather than using
// the Wasm null reference as a zero value.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports, wrapExports } from "../src/runtime.js";

async function run(source: string): Promise<number> {
  const result = await compile(source, { fileName: "test.ts" });
  expect(result.success).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setExports?.(instance.exports as Record<string, Function>);
  const exports = wrapExports(instance, { signatures: result.exportSignatures });
  return exports.test();
}

describe("#2106 JS-host default return values", () => {
  it("preserves undefined for explicit and implicit externref returns", async () => {
    expect(
      await run(`
        const explicit = (): any => { return; };
        const implicit = (): any => {};
        function classify(value: any): number {
          return value === undefined ? 1 : value === null ? 10 : 100;
        }
        export function test(): number {
          return classify(explicit()) + classify(implicit());
        }
      `),
    ).toBe(2);
  });
});
