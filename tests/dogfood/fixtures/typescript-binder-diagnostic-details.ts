// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { bindSourceFile } from "../.npm-upstream-suites/typescript/src/compiler/binder.js";
import { createSourceFile } from "../.npm-upstream-suites/typescript/src/compiler/parser.js";
import { ScriptKind, ScriptTarget } from "../.npm-upstream-suites/typescript/src/compiler/types.js";

import {
  runConstLocal as runConstCase,
  runDuplicateLet as runDuplicateCase,
} from "./typescript-binder-standalone-workload.js";

export function runConstLocal(): number {
  return runConstCase();
}

export function runDuplicateLet(): number {
  return runDuplicateCase();
}

export function runDiagnosticArrayBeforeBind(): number {
  const source = createSourceFile("input.ts", "let x;", ScriptTarget.Latest, true, ScriptKind.TS);
  if (source.bindDiagnostics === undefined) return -1;
  return source.bindDiagnostics.length;
}

export function runDiagnosticArrayPushBeforeBind(): number {
  const source = createSourceFile("input.ts", "let x;", ScriptTarget.Latest, true, ScriptKind.TS);
  source.bindDiagnostics.push({ file: source, start: 0, length: 0, category: 1, code: 9999, messageText: "probe" });
  return source.bindDiagnostics.length;
}

export function runDuplicateDiagnosticDetails(): number {
  const source = createSourceFile(
    "input.ts",
    "let x;\n// biome-ignore lint/suspicious/noRedeclare: intentional binder diagnostic fixture\nlet x;\n",
    ScriptTarget.Latest,
    true,
    ScriptKind.TS,
  );
  bindSourceFile(source, { target: ScriptTarget.Latest });
  if (source.bindDiagnostics.length !== 2) return -1;
  for (let i = 0; i < 2; i++) {
    const diagnostic = source.bindDiagnostics[i];
    if (diagnostic.start !== (i === 0 ? 4 : 94)) return -2;
    if (diagnostic.length !== 1) return -3;
    if (diagnostic.code !== 2451 || diagnostic.category !== 1) return -4;
    if (diagnostic.messageText !== "Cannot redeclare block-scoped variable 'x'.") return -5;
    if (diagnostic.file !== source) return -6;
  }
  return 1;
}
