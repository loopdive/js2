// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { compile, wrapExports } from "../src/index.js";

async function instantiate(result: Awaited<ReturnType<typeof compile>>) {
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  const imports = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (imports as { __setInstance?: (value: WebAssembly.Instance) => void }).__setInstance?.(instance);
  return wrapExports(instance, { signatures: result.exportSignatures });
}

describe("#1058 same-named parser and factory functions", () => {
  it("keeps a nested factory function distinct from a same-named top-level function", async () => {
    const result = await compile(
      `
        function createFactory() {
          function createSourceFile(statements: number, endOfFileToken: number, flags: number): number {
            return statements * 100 + endOfFileToken * 10 + flags;
          }

          return { createSourceFile };
        }

        export function createSourceFile(
          fileName: string,
          sourceText: string,
          languageVersion: number,
          setParentNodes = false,
          scriptKind?: number,
        ): number {
          return 999;
        }

        export function test(): number {
          const factory = createFactory();
          return factory.createSourceFile(4, 2, 3);
        }
      `,
      { fileName: "issue-1058-same-named-factory-function.ts", skipSemanticDiagnostics: true },
    );

    const exports = await instantiate(result);
    expect(exports.test()).toBe(423);
  });
});
