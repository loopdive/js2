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
 * (#7354 F1b) The `name` a function literal's function object gets (ES2015+, node's answer): its own name; for an
 * object literal's method its key, an accessor's prefixed with `get `/`set `; else NamedEvaluation's, from where the
 * anonymous definition stands: the bound identifier of a variable declarator or of a simple assignment, or the key of
 * an object literal's data property; `""` anywhere else (a computed key included).
 */
export function functionObjectName(
  expr: ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration | ts.AccessorDeclaration,
): string {
  if (!ts.isArrowFunction(expr) && expr.name) {
    const text =
      ts.isIdentifier(expr.name) || ts.isStringLiteral(expr.name) || ts.isNumericLiteral(expr.name)
        ? expr.name.text
        : "";
    return ts.isGetAccessorDeclaration(expr) ? `get ${text}` : ts.isSetAccessorDeclaration(expr) ? `set ${text}` : text;
  }
  let node: ts.Node = expr;
  while (ts.isParenthesizedExpression(node.parent)) node = node.parent;
  const { parent } = node;
  const named = (name: ts.Node): string =>
    ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) ? name.text : "";
  if (ts.isVariableDeclaration(parent) && parent.initializer === node) return named(parent.name);
  if (ts.isBinaryExpression(parent) && parent.right === node && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken)
    return ts.isIdentifier(parent.left) ? parent.left.text : "";
  return ts.isPropertyAssignment(parent) && parent.initializer === node ? named(parent.name) : "";
}
