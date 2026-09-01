// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { compile, wrapExports } from "../src/index.js";

describe("#1058 nullable generic call results", () => {
  it("checks an undefined overloaded token result before projecting its struct", async () => {
    const result = await compile(
      `
        type SyntaxKind = number;

        interface Node {
          readonly pos: number;
          readonly end: number;
          readonly kind: SyntaxKind;
          readonly flags: number;
          modifierFlagsCache: number;
          readonly transformFlags: number;
        }

        interface Token<TKind extends SyntaxKind = SyntaxKind> extends Node {
          readonly kind: TKind;
        }

        let currentToken = 28;

        function parseOptionalToken<TKind extends SyntaxKind>(kind: TKind): Token<TKind>;
        function parseOptionalToken(kind: SyntaxKind): Node | undefined {
          if (currentToken === kind) {
            return {
              pos: 0,
              end: 1,
              kind,
              flags: 0,
              modifierFlagsCache: 0,
              transformFlags: 0,
            };
          }
          return undefined;
        }

        export function test(): number {
          const questionDotToken = parseOptionalToken(29);
          return questionDotToken ? questionDotToken.kind : 0;
        }
      `,
      {
        fileName: "issue-1058-nullable-generic-call-result.ts",
        skipSemanticDiagnostics: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const imports = result.importObject ?? {};
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    (imports as { __setInstance?: (value: WebAssembly.Instance) => void }).__setInstance?.(instance);
    const exports = wrapExports(instance, { signatures: result.exportSignatures });
    expect(exports.test()).toBe(0);
  });

  it("checks an undefined token assignment used as a while condition", async () => {
    const result = await compile(
      `
        type SyntaxKind = number;

        interface Node {
          readonly pos: number;
          readonly end: number;
          readonly kind: SyntaxKind;
          readonly flags: number;
          modifierFlagsCache: number;
          readonly transformFlags: number;
        }

        interface Token<TKind extends SyntaxKind = SyntaxKind> extends Node {
          readonly kind: TKind;
        }

        function parseOptionalToken<TKind extends SyntaxKind>(kind: TKind): Token<TKind>;
        function parseOptionalToken(_kind: SyntaxKind): Node | undefined {
          return undefined;
        }

        export function test(): number {
          let operatorToken: Token<number>;
          let iterations = 0;
          while ((operatorToken = parseOptionalToken(28))) {
            iterations += operatorToken.kind;
          }
          return iterations;
        }
      `,
      {
        fileName: "issue-1058-nullable-generic-call-result-while.ts",
        skipSemanticDiagnostics: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const imports = result.importObject ?? {};
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    (imports as { __setInstance?: (value: WebAssembly.Instance) => void }).__setInstance?.(instance);
    const exports = wrapExports(instance, { signatures: result.exportSignatures });
    expect(exports.test()).toBe(0);
  });
});
