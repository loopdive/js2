// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Diagnostic decomposition only; the committed packed binder oracles remain unchanged.
import { bindSourceFile } from "../.npm-upstream-suites/typescript/src/compiler/binder.js";
import { createSourceFile } from "../.npm-upstream-suites/typescript/src/compiler/parser.js";
import { ScriptKind, ScriptTarget, type __String } from "../.npm-upstream-suites/typescript/src/compiler/types.js";

function parsed(duplicate: boolean) {
  const text = duplicate
    ? "let x;\n// biome-ignore lint/suspicious/noRedeclare: intentional binder diagnostic fixture\nlet x;\n"
    : "const x = 1;\n";
  return createSourceFile("input.ts", text, ScriptTarget.Latest, true, ScriptKind.TS);
}

function bound(duplicate: boolean) {
  const source = parsed(duplicate);
  bindSourceFile(source, { target: ScriptTarget.Latest });
  return source;
}

export function runConstParseShape(): number {
  const source = parsed(false);
  return (
    source.kind * 10000 +
    source.statements.length * 100 +
    source.parseDiagnostics.length * 10 +
    (source.locals === undefined ? 1 : 0)
  );
}
export function runConstSymbols(): number {
  return bound(false).symbolCount;
}
export function runConstLocals(): number {
  return bound(false).locals?.size ?? 0;
}
export function runConstDiagnostics(): number {
  return bound(false).bindDiagnostics.length;
}
export function runConstHasX(): number {
  return bound(false).locals?.has("x" as __String) ? 1 : 0;
}
export function runDuplicateSymbols(): number {
  return bound(true).symbolCount;
}
export function runDuplicateLocals(): number {
  return bound(true).locals?.size ?? 0;
}
export function runDuplicateDiagnostics(): number {
  return bound(true).bindDiagnostics.length;
}
