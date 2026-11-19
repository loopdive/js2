// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type ts from "typescript";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import type { InnerResult } from "./shared.js";
import {
  tryCompileStandaloneRegExpCompile,
  tryCompileStandaloneRegExpExec,
  tryCompileStandaloneRegExpTest,
  tryCompileStandaloneRegExpToString,
} from "./regexp-standalone.js";

/**
 * `re.exec(s)`, `re.test(s)`, `re.toString()` and `re.compile(p, f)` (#5142, Annex B §B.2.4.1) on a RegExp receiver,
 * through the native provider. Shared by the plain call path and `re?.m(…)` (#7395), which must not reach the
 * generic receiver ladder: it has no RegExp arm and would ask the host for `RegExp_test`.
 */
export function tryCompileStandaloneRegExpMethod(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
): InnerResult | undefined {
  for (const arm of [
    tryCompileStandaloneRegExpExec,
    tryCompileStandaloneRegExpTest,
    tryCompileStandaloneRegExpToString,
    tryCompileStandaloneRegExpCompile,
  ]) {
    const result = arm(ctx, fctx, expr, propAccess);
    if (result !== undefined) return result;
  }
  return undefined;
}
