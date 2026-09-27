// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Diagnostic controls alongside (not replacements for) the real-source oracles.
import {
  runBuilderStatePublic as builder,
  runCorePublic as core,
  runPerformanceCore as performance,
} from "./typescript-parser-standalone-workload.js";
import { createScanner } from "../.npm-upstream-suites/typescript/src/compiler/scanner.js";
import { createSourceFile } from "../.npm-upstream-suites/typescript/src/compiler/parser.js";
import { ScriptTarget, SyntaxKind } from "../.npm-upstream-suites/typescript/src/compiler/types.js";
import type { ExpressionStatement, Identifier } from "../.npm-upstream-suites/typescript/src/compiler/types.js";

export function runBuilderStatePublic(): number {
  return builder();
}
export function runCorePublic(): number {
  return core();
}
export function runPerformanceCore(): number {
  return performance();
}

export function runScannerProbe(): number {
  const scanner = createScanner(ScriptTarget.Latest, true);
  scanner.setText("import { x } from 'm';");
  const token = scanner.scan();
  if (token !== SyntaxKind.ImportKeyword) return -1000 - token;
  if (scanner.getTokenValue() !== "import") return -2;
  if (scanner.scan() !== SyntaxKind.OpenBraceToken) return -3;
  if (scanner.scan() !== SyntaxKind.Identifier) return -4;
  if (scanner.getTokenValue() !== "x") return -5;
  return 1;
}

export function runIdentifierProbe(): number {
  const source = createSourceFile("probe.ts", "x;", ScriptTarget.Latest, true);
  if (source.parseDiagnostics.length !== 0 || source.statements.length !== 1) return -1;
  const statement = source.statements[0] as ExpressionStatement;
  if (statement.kind !== SyntaxKind.ExpressionStatement) return -2;
  const identifier = statement.expression as Identifier;
  if (identifier.kind !== SyntaxKind.Identifier) return -3;
  return identifier.escapedText === "x" ? 1 : -4;
}

export function runImportProbe(): number {
  const source = createSourceFile("probe.ts", "import { x } from 'm';", ScriptTarget.Latest, true);
  if (source.parseDiagnostics.length !== 0) return -1;
  if (source.statements.length !== 1) return -2;
  return source.statements[0].kind === SyntaxKind.ImportDeclaration ? 1 : -3;
}
