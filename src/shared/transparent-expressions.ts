// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../ts-api.js";

/** The operand of a type-erased wrapper (`as`, `<T>`, `satisfies`, `!`), which emits nothing; else `undefined`. */
export function unwrapTypeErasedExpression(expr: ts.Expression): ts.Expression | undefined {
  return ts.isAsExpression(expr) ||
    ts.isTypeAssertionExpression(expr) ||
    ts.isSatisfiesExpression(expr) ||
    ts.isNonNullExpression(expr)
    ? expr.expression
    : undefined;
}

/**
 * Skip "transparent" wrapper expressions that have no runtime effect — parens
 * and the type-erased wrappers of {@link unwrapTypeErasedExpression} — to reach
 * the underlying expression. The local stand-in for `ts.skipOuterExpressions`
 * (not surfaced by the project's ts-api shim). Used to let `(this as any).x` /
 * `(B as any).c` resolve to the same receiver as `this.x` / `B.c`
 * (#2020/#2027). Shared with the IR (#7106); `codegen/shared.ts` re-exports it.
 */
export function skipTransparentExpressions(expr: ts.Expression): ts.Expression {
  let cur = expr;
  for (;;) {
    const next = ts.isParenthesizedExpression(cur) ? cur.expression : unwrapTypeErasedExpression(cur);
    if (next === undefined) return cur;
    cur = next;
  }
}
