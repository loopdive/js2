// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Diagnostic-collection triage: same parser call as the original upstream unit.
import * as ts from "../.npm-upstream-suites/typescript/src/compiler/_namespaces/ts.js";

function parse() {
  return ts.createSourceFile("index.ts", "const x = 1", ts.ScriptTarget.ESNext, true);
}

export function runStatement(): number {
  const file = parse();
  return file.statements.length === 1 && file.statements[0].kind === ts.SyntaxKind.VariableStatement ? 1 : 0;
}

export function runParent(): number {
  const file = parse();
  return file.statements[0].parent === file ? 1 : 0;
}

export function runSourceFileLookup(): number {
  const file = parse();
  return ts.getSourceFileOfNode(file.statements[0]) === file ? 1 : 0;
}
