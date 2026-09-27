// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Real upstream scanner controls; numeric exports require no host bridge.
import { createScanner } from "../.npm-upstream-suites/typescript/src/compiler/scanner.js";
import { ScriptTarget, SyntaxKind } from "../.npm-upstream-suites/typescript/src/compiler/types.js";

export function runImportToken(): number {
  const scanner = createScanner(ScriptTarget.Latest, true);
  scanner.setText("import { x } from 'm';");
  return scanner.scan();
}
export function runImportValue(): number {
  const scanner = createScanner(ScriptTarget.Latest, true);
  scanner.setText("import { x } from 'm';");
  scanner.scan();
  return scanner.getTokenValue() === "import" ? 1 : 0;
}
export function runIdentifierToken(): number {
  const scanner = createScanner(ScriptTarget.Latest, true);
  scanner.setText("x;");
  return scanner.scan();
}
export function runIdentifierValue(): number {
  const scanner = createScanner(ScriptTarget.Latest, true);
  scanner.setText("x;");
  scanner.scan();
  return scanner.getTokenValue() === "x" ? 1 : 0;
}

export function runImportSequence(): number {
  const scanner = createScanner(ScriptTarget.Latest, true);
  scanner.setText("import { x } from 'm';");
  const expected = [
    SyntaxKind.ImportKeyword,
    SyntaxKind.OpenBraceToken,
    SyntaxKind.Identifier,
    SyntaxKind.CloseBraceToken,
    SyntaxKind.FromKeyword,
    SyntaxKind.StringLiteral,
    SyntaxKind.SemicolonToken,
    SyntaxKind.EndOfFileToken,
  ];
  for (let index = 0; index < expected.length; index++) {
    if (scanner.scan() !== expected[index]) return -index - 1;
  }
  return 1;
}
