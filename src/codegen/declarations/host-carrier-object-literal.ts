// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6650) The two reasons an object literal is built on the open host
 * `$Object` route (`__new_plain_object` + `__extern_set`, yielding an
 * externref) rather than as a closed WasmGC struct:
 *
 *  - its SHAPE forbids a struct — `objectLiteralForcesHostPath` (accessors,
 *    runtime-computed keys, colon-`__proto__`, an empty-string key, …);
 *  - it SPREADS into a non-specific contextual position —
 *    `objectLiteralSpreadTakesHostPath` (#2804).
 *
 * Every boundary that has to pin a carrier for such a literal must consult
 * BOTH, or the two halves disagree: the value is an externref while the
 * boundary's ABI is the checker-inferred concrete struct, and the guarded
 * downcast (`ref.test` → `ref.cast` / `ref.null none`) takes the null arm on
 * every evaluation. `typeof` still answers `"object"`; every property read
 * answers null or traps.
 *
 * The local-binding boundary (`statements/variables.ts`) and the captured-init
 * boundary (`statements/nested-declarations.ts`) already do. The FUNCTION
 * RETURN boundary (`functionReturnsHostObjectLiteralCarrier`) consulted only
 * the shape-driven predicate until #6650, which is why
 * `function f() { const o = {…}; return { ...o, days: 9 }; }` answered null for
 * every caller — the defect behind `Temporal.PlainDate.prototype.add` failing
 * for every input in standalone (the polyfill's `Wr()` is exactly that shape).
 */
import { objectLiteralForcesHostPath, objectLiteralSpreadTakesHostPath } from "../literals.js";
import { ts } from "../../ts-api.js";
import type { CodegenContext } from "../context/types.js";

/** True when this literal's VALUE is an open host `$Object` externref, for either reason. */
export function objectLiteralTakesHostCarrier(ctx: CodegenContext, expr: ts.ObjectLiteralExpression): boolean {
  return objectLiteralForcesHostPath(ctx, expr) || objectLiteralSpreadTakesHostPath(ctx, expr);
}

/**
 * Peel the wrappers that do not change WHICH value leaves a return slot, so a
 * carrier scan sees the literal underneath.
 *
 * (#6652) Lives here, next to the predicate, because two boundaries consult it
 * and a disagreement between them is invisible: `declarations.ts`'s
 * `functionReturnsHostObjectLiteralCarrier` (the FunctionDeclaration lane) and
 * `accessor-literal-return-carrier.ts`'s pre-pass (every other callable shape).
 * The pre-pass had its own copy that lacked the comma arm — and the comma arm
 * is the one that matters in practice: the minified `@js-temporal/polyfill`
 * writes its date arithmetic as `return zr(…), { ...t.date, days: n }`, so
 * without it the scan never sees the spread literal at all (#6650 measured
 * that as a byte-identical binary).
 */
export function unwrapReturnCarrierExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    // A COMMA expression's value is its right operand.
    (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.CommaToken)
  ) {
    current = ts.isBinaryExpression(current) ? current.right : current.expression;
  }
  return current;
}

/**
 * Exact captured const allocation provenance for a callable's result carrier.
 * An asserted/annotated return type or an unrelated same-name binding is not
 * evidence. The allocation stays the same object even when its members change.
 */
export function isCapturedConstHostLiteral(ctx: CodegenContext, expression: ts.Expression, owner: ts.Node): boolean {
  const current = unwrapReturnCarrierExpression(expression);
  if (!ts.isIdentifier(current)) return false;
  const declaration = ctx.oracle.valueDeclarationOf(current);
  const declarations = ctx.oracle.declarationsOf(current);
  if (
    declaration === undefined ||
    !ts.isVariableDeclaration(declaration) ||
    declarations.length !== 1 ||
    declarations[0] !== declaration ||
    declaration.getSourceFile() !== owner.getSourceFile() ||
    declaration.getSourceFile().isDeclarationFile ||
    !ts.isIdentifier(declaration.name) ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    (declaration.parent.flags & ts.NodeFlags.Const) === 0 ||
    (declaration.parent.flags & ts.NodeFlags.Using) !== 0 ||
    declaration.initializer === undefined
  ) {
    return false;
  }
  const allocation = unwrapReturnCarrierExpression(declaration.initializer);
  return ts.isObjectLiteralExpression(allocation) && objectLiteralTakesHostCarrier(ctx, allocation);
}

/** Scoped returned-value proof shared by real and Phase-0 nested signatures. */
export function functionReturnsCapturedConstHostLiteral(ctx: CodegenContext, fn: ts.FunctionDeclaration): boolean {
  if (!fn.body) return false;
  const matches = (expression: ts.Expression): boolean => {
    const current = unwrapReturnCarrierExpression(expression);
    if (ts.isConditionalExpression(current)) return matches(current.whenTrue) || matches(current.whenFalse);
    return isCapturedConstHostLiteral(ctx, current, fn);
  };
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      node !== fn.body &&
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node) ||
        ts.isConstructorDeclaration(node))
    )
      return;
    if (ts.isReturnStatement(node) && node.expression && matches(node.expression)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(fn.body);
  return found;
}
