// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#6988) Per-body index of identifier write targets, for the closure-capture
// planner's "is this captured name written outside the closure?" question.
import { ts, forEachChild } from "../../ts-api.js";
import { isLexicalBindingWrite, varDeclaratorWrittenNames } from "../../ir/analysis/binding-writes.js";

/**
 * Identifier write targets of an enclosing body (every form
 * `isLexicalBindingWrite` recognises, plus `var` re-declarations, #6992),
 * grouped by name and indexed once per body. That walk ran once per (closure, referenced name) over the whole
 * enclosing body — at top level the whole file — which made compiling the 5 MB
 * Octane mandreel driver quadratic.
 */
const writeTargetsByBody = new WeakMap<ts.Node, Map<string, ts.Identifier[]>>();

export function writeTargetsByName(body: ts.Node): Map<string, ts.Identifier[]> {
  const cached = writeTargetsByBody.get(body);
  if (cached) return cached;
  const index = new Map<string, ts.Identifier[]>();
  const add = (id: ts.Identifier): void => {
    const list = index.get(id.text);
    if (list) list.push(id);
    else index.set(id.text, [id]);
  };
  const visit = (node: ts.Node): void => {
    // (#6992) Every write form: any assignment operator, `++`/`--`,
    // destructuring targets, for-in/for-of heads — and the names a `var`
    // declarator with an initializer assigns (a re-declaration is a write; the
    // caller drops the captured binding's own declarator).
    if (ts.isIdentifier(node) && isLexicalBindingWrite(node)) add(node);
    for (const id of varDeclaratorWrittenNames(node)) add(id);
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
