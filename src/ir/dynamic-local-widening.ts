// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../ts-api.js";

/**
 * #3795 — prove the narrow mutable-local shape needed by Acorn's
 * `isPrivateNameConflicted`:
 *
 *   var next = "true";
 *   …
 *   next = (dynamicMember ? "s" : "i") + dynamicMember;
 *
 * The result is shared by selection and AST→IR lowering so widening cannot
 * claim and then demote. Candidates must be direct function-body mutable
 * declarations with a string-literal initializer; every write must be a plain
 * statement-position `=` whose RHS is a dynamic string concat. Compound,
 * update, assignment-as-value, nested-function, and wider mixed writes reject.
 */
export function collectDynamicStringLocalWidening(
  fn: ts.FunctionLikeDeclaration,
  initialDynamicNames: ReadonlySet<string>,
): ReadonlySet<string> {
  if (!fn.body || !ts.isBlock(fn.body) || initialDynamicNames.size === 0) return new Set();

  const candidates = new Map<string, ts.VariableDeclaration>();
  for (const statement of fn.body.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    if ((statement.declarationList.flags & ts.NodeFlags.Const) !== 0) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.type === undefined &&
        declaration.initializer !== undefined &&
        ts.isStringLiteralLike(declaration.initializer)
      ) {
        candidates.set(declaration.name.text, declaration);
      }
    }
  }
  if (candidates.size === 0) return new Set();

  const writes = new Map<string, ts.Expression[]>();
  const invalid = new Set<string>();
  const assignmentOperators = new Set<ts.SyntaxKind>([
    ts.SyntaxKind.EqualsToken,
    ts.SyntaxKind.PlusEqualsToken,
    ts.SyntaxKind.MinusEqualsToken,
    ts.SyntaxKind.AsteriskEqualsToken,
    ts.SyntaxKind.SlashEqualsToken,
    ts.SyntaxKind.PercentEqualsToken,
    ts.SyntaxKind.AsteriskAsteriskEqualsToken,
    ts.SyntaxKind.LessThanLessThanEqualsToken,
    ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
    ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
    ts.SyntaxKind.AmpersandEqualsToken,
    ts.SyntaxKind.BarEqualsToken,
    ts.SyntaxKind.CaretEqualsToken,
    ts.SyntaxKind.QuestionQuestionEqualsToken,
    ts.SyntaxKind.AmpersandAmpersandEqualsToken,
    ts.SyntaxKind.BarBarEqualsToken,
  ]);

  const visit = (node: ts.Node, parent?: ts.Node): void => {
    if (node !== fn.body && ts.isFunctionLike(node)) return;
    if (
      ts.isBinaryExpression(node) &&
      assignmentOperators.has(node.operatorToken.kind) &&
      ts.isIdentifier(node.left) &&
      candidates.has(node.left.text)
    ) {
      if (
        node.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
        !parent ||
        !ts.isExpressionStatement(parent) ||
        parent.expression !== node
      ) {
        invalid.add(node.left.text);
      } else {
        const list = writes.get(node.left.text);
        if (list) list.push(node.right);
        else writes.set(node.left.text, [node.right]);
      }
    } else if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      ts.isIdentifier(node.operand) &&
      candidates.has(node.operand.text) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      invalid.add(node.operand.text);
    }
    ts.forEachChild(node, (child) => visit(child, node));
  };
  visit(fn.body);

  const unwrap = (expression: ts.Expression): ts.Expression => {
    let current = expression;
    while (ts.isParenthesizedExpression(current)) current = current.expression;
    return current;
  };

  const dynamicRooted = (expression: ts.Expression): boolean => {
    const candidate = unwrap(expression);
    if (ts.isIdentifier(candidate)) return initialDynamicNames.has(candidate.text);
    if (ts.isPropertyAccessExpression(candidate) || ts.isElementAccessExpression(candidate)) {
      return dynamicRooted(candidate.expression);
    }
    return false;
  };

  const concreteStringPiece = (expression: ts.Expression): boolean => {
    const candidate = unwrap(expression);
    if (ts.isStringLiteralLike(candidate)) return true;
    return (
      ts.isConditionalExpression(candidate) &&
      dynamicRooted(candidate.condition) &&
      concreteStringPiece(candidate.whenTrue) &&
      concreteStringPiece(candidate.whenFalse)
    );
  };

  const dynamicStringPiece = (expression: ts.Expression): boolean => {
    const candidate = unwrap(expression);
    if (dynamicRooted(candidate)) return true;
    if (!ts.isBinaryExpression(candidate) || candidate.operatorToken.kind !== ts.SyntaxKind.PlusToken) return false;
    const leftDynamic = dynamicStringPiece(candidate.left);
    const rightDynamic = dynamicStringPiece(candidate.right);
    return (
      (leftDynamic && (rightDynamic || concreteStringPiece(candidate.right))) ||
      (rightDynamic && concreteStringPiece(candidate.left))
    );
  };

  const widened = new Set<string>();
  for (const name of candidates.keys()) {
    const assignments = writes.get(name) ?? [];
    if (
      !invalid.has(name) &&
      assignments.length > 0 &&
      assignments.every((rhs) => {
        const candidate = unwrap(rhs);
        return (
          ts.isBinaryExpression(candidate) &&
          candidate.operatorToken.kind === ts.SyntaxKind.PlusToken &&
          dynamicStringPiece(candidate)
        );
      })
    ) {
      widened.add(name);
    }
  }
  return widened;
}
