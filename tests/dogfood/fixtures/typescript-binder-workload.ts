// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Tracked binder entry for the pinned TypeScript upstream-source checkout.
import { bindSourceFile } from "../.npm-upstream-suites/typescript/src/compiler/binder.js";
import { createSourceFile } from "../.npm-upstream-suites/typescript/src/compiler/parser.js";
import { ScriptKind, ScriptTarget } from "../.npm-upstream-suites/typescript/src/compiler/types.js";

export function runCase(sourceText: string): number {
  const source = createSourceFile("input.ts", sourceText, ScriptTarget.Latest, true, ScriptKind.TS);
  if (source.parseDiagnostics.length !== 0) return -source.parseDiagnostics.length;

  bindSourceFile(source, { target: ScriptTarget.Latest });

  const symbolCount = source.symbolCount;
  const localCount = source.locals?.size ?? 0;
  const diagnosticCount = source.bindDiagnostics.length;
  if (symbolCount >= 32_768 || localCount >= 256 || diagnosticCount >= 256) {
    throw new Error("Binder smoke oracle packing overflow");
  }
  // This first bounded oracle is deliberately collision-prone. Later binder
  // milestones add a deterministic sorted name-and-flags sequence/hash.
  return symbolCount * 65_536 + localCount * 256 + diagnosticCount;
}
