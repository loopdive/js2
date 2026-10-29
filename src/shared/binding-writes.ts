// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6992) "Does this identifier WRITE its binding?" — the one shared answer for
 * every closure-capture / loop-boxing write scan, legacy codegen and IR alike.
 *
 * The scans used to recognise only `x = …`, compound assignment and `++/--` on
 * a bare identifier. Writes through a destructuring target (`[a] = …`,
 * `({a} = …)`, `[a, b] = [b, a]`), a `for (a of …)` / `for (k in …)` head and a
 * `var` re-declaration with an initializer were missed, so the capture stayed
 * by-value and the closure read a stale snapshot. Pure AST: no checker, no
 * CodegenContext — it sits in `src/shared` (below both) so `src/ir` and `src/codegen` share it
 * without a new codegen<->ir import edge.
 */
import { ts } from "../ts-api.js";

/**
 * True when `identifier` is the target an assignment (any `=`/compound/logical
 * operator), an update (`++`/`--`) or a for-in/for-of head writes — following
 * destructuring containers (array/object literal, spread, shorthand, property
 * value, `[a = 1]` default) and type-only wrappers, never a member receiver or
 * a computed key.
 */
export function isLexicalBindingWrite(identifier: ts.Identifier): boolean {
  return isWriteTarget(identifier);
}

/**
 * (#7189) {@link isLexicalBindingWrite} for any assignment target, a member
 * access included: `[Array.isArray] = xs` writes `Array.isArray`.
 */
export function isWriteTarget(expression: ts.Expression): boolean {
  let target: ts.Node = expression;
  for (;;) {
    const parent = target.parent;
    if (!parent) return false;
    if (ts.isBinaryExpression(parent))
      return (
        parent.left === target &&
        parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      );
    if (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent))
      return (
        parent.operand === target &&
        (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken)
      );
    if (ts.isForOfStatement(parent) || ts.isForInStatement(parent)) return parent.initializer === target;
    if (
      (ts.isParenthesizedExpression(parent) && parent.expression === target) ||
      (ts.isAsExpression(parent) && parent.expression === target) ||
      (ts.isSatisfiesExpression(parent) && parent.expression === target) ||
      (ts.isNonNullExpression(parent) && parent.expression === target) ||
      (ts.isTypeAssertionExpression(parent) && parent.expression === target) ||
      (ts.isSpreadElement(parent) && parent.expression === target) ||
      (ts.isSpreadAssignment(parent) && parent.expression === target) ||
      (ts.isPropertyAssignment(parent) && parent.initializer === target) ||
      (ts.isShorthandPropertyAssignment(parent) && parent.name === target) ||
      ts.isArrayLiteralExpression(parent) ||
      ts.isObjectLiteralExpression(parent)
    ) {
      target = parent;
      continue;
    }
    return false;
  }
}

/**
 * The binding identifiers a `var` declarator with an initializer assigns; empty
 * for anything else. A `var` that re-declares an existing binding
 * (`var v = 1; … var v = 2;`, or a parameter re-declared by `var`) is a plain
 * write to that binding, so a scan that already knows the captured binding's
 * own declaration counts every OTHER declarator returned here as a write.
 */
export function varDeclaratorWrittenNames(node: ts.Node): ts.Identifier[] {
  if (!ts.isVariableDeclaration(node) || !node.initializer) return [];
  const list = node.parent;
  if (!ts.isVariableDeclarationList(list) || (list.flags & ts.NodeFlags.BlockScoped) !== 0) return [];
  const out: ts.Identifier[] = [];
  const visit = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) {
      out.push(name);
      return;
    }
    for (const element of name.elements) if (!ts.isOmittedExpression(element)) visit(element.name);
  };
  visit(node.name);
  return out;
}
