// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#6988) Per-body index of identifier write targets, for the closure-capture
// planner's "is this captured name written outside the closure?" question.
import { ts, forEachChild } from "../../ts-api.js";

/**
 * Identifier write targets of an enclosing body (`x = …`, compound `x op= …`,
 * and every prefix/postfix unary operand — exactly the shapes the per-name walk
 * in `planClosureCaptures` used to match), grouped by name and indexed once per
 * body. That walk ran once per (closure, referenced name) over the whole
 * enclosing body — at top level the whole file — which made compiling the 5 MB
 * Octane mandreel driver quadratic.
 */
const writeTargetsByBody = new WeakMap<ts.Node, Map<string, ts.Identifier[]>>();

export function writeTargetsByName(body: ts.Node): Map<string, ts.Identifier[]> {
  const cached = writeTargetsByBody.get(body);
  if (cached) return cached;
  const index = new Map<string, ts.Identifier[]>();
  const add = (id: ts.Expression): void => {
    if (!ts.isIdentifier(id)) return;
    const list = index.get(id.text);
    if (list) list.push(id);
    else index.set(id.text, [id]);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node)) {
      const kind = node.operatorToken.kind;
      if (
        kind === ts.SyntaxKind.EqualsToken ||
        (kind >= ts.SyntaxKind.PlusEqualsToken && kind <= ts.SyntaxKind.CaretEqualsToken)
      ) {
        add(node.left);
      }
    } else if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
      add(node.operand);
    }
    forEachChild(node, visit);
  };
  if (ts.isBlock(body)) for (const stmt of body.statements) visit(stmt);
  else visit(body);
  writeTargetsByBody.set(body, index);
  return index;
}

/** Is `node` `ancestor` itself or inside its subtree? */
export function isWithinNode(node: ts.Node, ancestor: ts.Node): boolean {
  for (let cur: ts.Node | undefined = node; cur; cur = cur.parent) if (cur === ancestor) return true;
  return false;
}
