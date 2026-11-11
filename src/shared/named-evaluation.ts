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
