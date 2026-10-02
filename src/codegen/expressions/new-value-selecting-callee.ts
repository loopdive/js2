// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6738 — host-free `new (a || B)()`: a `new` whose callee SELECTS a
 * constructor value at run time.
 *
 * lodash-es spells `new (Map || ListCache)` in `_mapCacheClear.js` and
 * `_stackSet.js`. Under `--target standalone` every static `new` arm declines
 * that callee (it is no identifier, member access or call), the host-free
 * dynamic-`new` chains admitted only those three shapes, and the legacy
 * `__new_<name>` terminal has no import in standalone — so the `new` answered
 * **null** with no trap and no diagnostic.
 *
 * The value-dispatched `__native_construct_<N>` driver (#3981) already owns
 * this exactly: it evaluates the callee ONCE to an externref and dispatches on
 * the runtime value (closure, class object, Proxy, collection carrier #6720),
 * reading `callee.prototype` itself when no fnctor global is statically known.
 * This predicate is only the admission: a callee whose value is one of its
 * operands — `a || b`, `a ?? b`, `a && b`, `c ? a : b`, `(x, a)` — seen
 * through parentheses / casts. Every other callee keeps its established arm;
 * in particular `new (f())()` stays out (the #6651 F4 note: a call in callee
 * position is a much larger blast radius).
 */
import { ts } from "../../ts-api.js";
import type { CodegenContext } from "../context/types.js";
import { noJsHost } from "../js-errors.js";

function unwrapCallee(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

const VALUE_SELECTING_OPERATORS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.CommaToken,
]);

/** Is `calleeExpr` (through parens/casts) a runtime selection between values? */
export function isValueSelectingNewCallee(calleeExpr: ts.Expression): boolean {
  const callee = unwrapCallee(calleeExpr);
  if (ts.isConditionalExpression(callee)) return true;
  return ts.isBinaryExpression(callee) && VALUE_SELECTING_OPERATORS.has(callee.operatorToken.kind);
}

/**
 * `compileNewExpression`'s door for the value-selecting arm: host-free only,
 * and not when the checker already names a compiled class result
 * (`new (c ? A : B)()` of two same-shaped classes reduces to `A`), whose typed
 * consumers the static class arm owns.
 */
export function isValueSelectingNewSite(
  ctx: CodegenContext,
  calleeExpr: ts.Expression,
  className: string | undefined,
): boolean {
  return noJsHost(ctx) && isValueSelectingNewCallee(calleeExpr) && !(className && ctx.classSet.has(className));
}
