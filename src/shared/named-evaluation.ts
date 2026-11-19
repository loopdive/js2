// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * NamedEvaluation's trigger, shared below codegen and the IR: legacy property
 * and binding naming (#1049) and the IR's literal destructuring planner, which
 * refuses a default that would be named after its leaf (#7106).
 */
import { ts } from "../ts-api.js";

/**
 * ES spec IsAnonymousFunctionDefinition: returns true when the expression is
 * an anonymous FunctionExpression / ArrowFunction / ClassExpression (with
 * optional parentheses around it). Used by NamedEvaluation to decide whether
 * a binding name is assigned to the function's .name. (#1049)
 */
export function isAnonymousFunctionDefinition(expr: ts.Expression): boolean {
  while (ts.isParenthesizedExpression(expr)) expr = expr.expression;
  if (ts.isFunctionExpression(expr) && !expr.name) return true;
  if (ts.isArrowFunction(expr)) return true;
  if (ts.isClassExpression(expr) && !expr.name) return true;
  return false;
}

/**
 * The name NamedEvaluation gives the anonymous function definition `expr` from where it stands (ES2015+): the bound
 * identifier of a variable declarator or of a simple assignment, or the key of an object literal's data property;
 * `""` anywhere else.
 */
export function namedEvaluationName(expr: ts.Expression): string {
  let node: ts.Node = expr;
  while (ts.isParenthesizedExpression(node.parent)) node = node.parent;
  const { parent } = node;
  if (ts.isVariableDeclaration(parent) && parent.initializer === node && ts.isIdentifier(parent.name))
    return parent.name.text;
  if (
    ts.isBinaryExpression(parent) &&
    parent.right === node &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isIdentifier(parent.left)
  )
    return parent.left.text;
  if (
    ts.isPropertyAssignment(parent) &&
    parent.initializer === node &&
    (ts.isIdentifier(parent.name) || ts.isStringLiteral(parent.name) || ts.isNumericLiteral(parent.name))
  )
    return parent.name.text;
  return "";
}
