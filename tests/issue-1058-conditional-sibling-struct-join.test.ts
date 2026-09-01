// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { compile, wrapExports } from "../src/index.js";

async function compileAndInstantiate(source: string): Promise<Record<string, Function>> {
  const result = await compile(source, {
    target: "gc",
    platform: "node",
    skipSemanticDiagnostics: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  const imports = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (imports as { __setInstance?: (value: WebAssembly.Instance) => void }).__setInstance?.(instance);
  return wrapExports(instance, { signatures: result.exportSignatures }) as Record<string, Function>;
}

describe("#1058 conditional sibling struct join", () => {
  it("preserves either nominal sibling instead of casting the false arm to the true arm", async () => {
    const exports = await compileAndInstantiate(`
      interface Node { kind: number; }
      interface Identifier extends Node { escapedText: string; symbolId: number; }
      interface StringLiteral extends Node { text: string; }

      function parseIdentifierName(): Identifier {
        return { kind: 80, escapedText: "Diagnostic", symbolId: 1 };
      }

      function parseLiteralNode(): StringLiteral {
        return { kind: 11, text: "literal" };
      }

      function parseModuleExportName(
        literal: boolean,
        parseName: () => Identifier,
      ): Identifier | StringLiteral {
        return literal ? parseLiteralNode() : parseName();
      }

      export function kind(literal: boolean): number {
        return parseModuleExportName(literal, parseIdentifierName).kind;
      }
    `);

    expect(exports.kind(true)).toBe(11);
    expect(exports.kind(false)).toBe(80);
  });
});
