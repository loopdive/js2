// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../../ts-api.js";
import type { CodegenContext } from "../context/types.js";

/**
 * (#7106 S3c-b) Is `decl` a top-level SELF-GUARDED constructor —
 *
 * ```js
 * function F(m) {
 *   if (!(this instanceof F)) return new F(m);
 *   ...
 * }
 * ```
 *
 * (test262's `sta.js` `Test262Error`)? The guard makes every plain call
 * `F(m)` return `new F(m)`, so the legacy fnctor lowering types F's CALLABLE
 * return slot as its `__fnctor_F` struct — an ABI the IR cannot express, which
 * keeps F (and every harness unit that constructs it) on the legacy path.
 *
 * The standalone lane therefore keeps such a constructor out of the fnctor
 * machinery altogether: the escape gate refuses it and its `new F(...)` sites
 * take the generic construct-from-value path. Instances are ordinary objects
 * with the same observable behaviour (the shape is construct-and-read, never a
 * hot allocation site), and F's own signature stays plain externref, which the
 * IR can claim.
 *
 * Pure AST: no checker. The IR selector and lowering reach it only through
 * codegen's selection callbacks, so the two frontends ask the SAME question.
 */
export function isSelfGuardedConstructor(decl: ts.Node): decl is ts.FunctionDeclaration {
  if (!ts.isFunctionDeclaration(decl) || decl.name === undefined || decl.body === undefined) return false;
  if (!ts.isSourceFile(decl.parent)) return false;
  const name = decl.name.text;
  const first = decl.body.statements[0];
  if (first === undefined || !ts.isIfStatement(first) || first.elseStatement !== undefined) return false;
  if (!isNotThisInstanceOf(first.expression, name)) return false;
  let guard: ts.Statement = first.thenStatement;
  if (ts.isBlock(guard)) {
    if (guard.statements.length !== 1) return false;
    guard = guard.statements[0]!;
  }
  if (!ts.isReturnStatement(guard) || guard.expression === undefined) return false;
  const returned = unwrapParens(guard.expression);
  return ts.isNewExpression(returned) && isIdentifierNamed(returned.expression, name);
}

/**
 * Does this compile keep self-guarded constructors out of the fnctor machinery?
 * Standalone only, and never when runtime eval may share the realm (#7106 S3c
 * regression, merge group pr-6844): there the identifier reads through the
 * global-binding adapter, so an instance's `constructor` is the raw function
 * and `e.constructor === Test262Error` fails. Legacy's fnctor path keeps the
 * two identical, so such programs stay on it.
 */
export function selfGuardedConstructorsLeaveFnctor(ctx: CodegenContext): boolean {
  const plan = ctx.runtimeEvalBoundaryPlan;
  if (!ctx.standalone || plan === undefined) return false;
  return ctx.runtimeEvalProviderAbsent === true || !plan.sharedRealmMayContainCanonicalValues;
}

function isNotThisInstanceOf(condition: ts.Expression, name: string): boolean {
  const negated = unwrapParens(condition);
  if (!ts.isPrefixUnaryExpression(negated) || negated.operator !== ts.SyntaxKind.ExclamationToken) return false;
  const test = unwrapParens(negated.operand);
  return (
    ts.isBinaryExpression(test) &&
    test.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword &&
    test.left.kind === ts.SyntaxKind.ThisKeyword &&
    isIdentifierNamed(test.right, name)
  );
}

function isIdentifierNamed(node: ts.Expression, name: string): boolean {
  const target = unwrapParens(node);
  return ts.isIdentifier(target) && target.text === name;
}

function unwrapParens(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}
