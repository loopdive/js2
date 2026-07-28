// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { runTest262File } from "./test262-runner.js";

async function run(source: string): Promise<unknown> {
  const result = await compile(source, {
    fileName: "issue-3762.ts",
    skipSemanticDiagnostics: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as unknown as WebAssembly.Imports);
  imports.setExports?.(instance.exports as Record<string, Function>);
  return (instance.exports as unknown as { test: () => unknown }).test();
}

describe("#3762 — String.prototype.replace coercion order", { timeout: 30_000 }, () => {
  it("coerces searchValue before a non-callable replaceValue", async () => {
    const result = await run(`
      export function test(): number {
        const searchValue: any = {
          toString: function(): string { throw "search"; },
        };
        const replaceValue: any = {
          toString: function(): string { throw "replacement"; },
        };
        try {
          "subject".replace(searchValue, replaceValue);
        } catch (error) {
          if (error === "search") return 1;
          if (error === "replacement") return 2;
        }
        return 0;
      }
    `);
    expect(result).toBe(1);
  });

  for (const file of ["S15.5.4.11_A1_T11.js", "S15.5.4.11_A1_T12.js"]) {
    it(`passes the ES5 Test262 case ${file}`, async () => {
      const result = await runTest262File(
        resolve("test262/test/built-ins/String/prototype/replace", file),
        "built-ins/String",
      );
      expect(result.status, result.error).toBe("pass");
    });
  }
});
