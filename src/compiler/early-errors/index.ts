// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// ES early-error detection (#1931). TypeScript does not enforce ECMA-262 early
// errors (strict-mode rules, TDZ, duplicate lexical declarations, labels,
// assignment targets, private names, …), but test262 `negative.phase: parse`
// demands them. This was a single ~3,350-line function in validation.ts; it is
// now decomposed into per-concern rule modules that share one AST walk through
// an EarlyErrorContext. Behaviour is identical — this is a pure refactor.
import type { ts } from "../../ts-api.js";
import type { CompileError } from "../../index.js";
import { createEarlyErrorContext } from "./context.js";
import { runNodeChecks } from "./node-checks.js";
import { checkDuplicateLabels } from "./labels.js";
import {
  checkDuplicateConstructors,
  checkDuplicateExportNames,
  checkExportDefaultDeclaration,
  checkHtmlCloseComment,
  checkModuleItemPosition,
  checkReservedIdentifiers,
} from "./module-rules.js";

/**
 * Detect ECMA-262 early errors (SyntaxErrors that TypeScript's parser misses)
 * in a parsed source file. Returns a list of errors/warnings; an empty list
 * means the source has no detectable early errors.
 *
 * The order of the passes below is preserved exactly from the original
 * monolithic implementation.
 */
export function detectEarlyErrors(sourceFile: ts.SourceFile, opts?: { moduleGoal?: boolean }): CompileError[] {
  const ctx = createEarlyErrorContext(sourceFile, opts);

  // Per-node walk: update/assignment targets, strict-mode rules, duplicate
  // params, statement-position declarations, private names, var/lexical
  // conflicts, TDZ, switch-case lexical scoping, generator/async params, …
  runNodeChecks(ctx, sourceFile);

  // Source-file level passes (run after the per-node walk, in original order).
  checkExportDefaultDeclaration(ctx);
  checkDuplicateLabels(ctx, sourceFile, new Set());
  checkDuplicateExportNames(ctx);
  checkModuleItemPosition(ctx);
  checkReservedIdentifiers(ctx);
  checkHtmlCloseComment(ctx);
  checkDuplicateConstructors(ctx);

  return ctx.errors;
}
