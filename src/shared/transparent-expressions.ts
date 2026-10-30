// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../ts-api.js";

/**
 * Skip "transparent" wrapper expressions that have no runtime effect — parens,
 * `as`/`<T>` casts, `satisfies`, and non-null `!` — to reach the underlying
 * expression. The local stand-in for `ts.skipOuterExpressions` (not surfaced by
 * the project's ts-api shim). Used to let `(this as any).x` / `(B as any).c`
 * resolve to the same receiver as `this.x` / `B.c` (#2020/#2027). Shared with
 * the IR (#7106); `codegen/shared.ts` re-exports it.
 */
export function skipTransparentExpressions(expr: ts.Expression): ts.Expression {
  let cur = expr;
  while (
    ts.isParenthesizedExpression(cur) ||
    ts.isAsExpression(cur) ||
    ts.isTypeAssertionExpression(cur) ||
    ts.isSatisfiesExpression(cur) ||
    ts.isNonNullExpression(cur)
  ) {
    cur = cur.expression;
  }
  return cur;
}
