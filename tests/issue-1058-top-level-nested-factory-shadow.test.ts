// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

describe("#1058 top-level/nested factory function shadowing", () => {
  it("stores the nested function in a same-named factory shorthand", async () => {
    const result = await compile(
      `
        interface Factory {
          createSourceFile: (statements: number, endOfFile: number, flags: number) => number;
        }

        function createSourceFile(
          fileName: number,
          sourceText: number,
          languageVersion: number,
          setParentNodes: number,
          scriptKind: number,
        ): number {
          return 900 + fileName;
        }

        function createFactory(): Factory {
          function createSourceFile(statements: number, endOfFile: number, flags: number): number {
            return statements + endOfFile + flags;
          }

          return { createSourceFile };
        }

        export function test(): number {
          const nested = createFactory().createSourceFile(1, 2, 4);
          const outer = createSourceFile(1, 2, 3, 4, 5);
          return nested * 1000 + outer;
        }
      `,
      { fileName: "issue-1058-top-level-nested-factory-shadow.ts", skipSemanticDiagnostics: true },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
    expect((instance.exports.test as () => number)()).toBe(7901);
  });
});
