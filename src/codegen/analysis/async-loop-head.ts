// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#7096) Admission rules for the `for (init; cond; incr)` head of the async
// loop CFG (`analyzeLoopAsync` / `planLoopCfg` in async-cps.ts). The loop CFG
// runs the head's pieces in separate states of the resume machine — `init`
// once in the entry state, `cond` in the loop head, `incr` in the continuation
// after the body's last await — so the head may only bind names whose single
// shared slot is indistinguishable from the per-iteration environments of
// ECMA-262 §14.7.4.4 (CreatePerIterationEnvironment):
//
//   - `let`/`var` declarators with identifier names (a `const` head can only
//     loop through a throwing incrementor; `using` heads need disposal);
//   - every `let` declarator has an initializer (a bare `let i;` re-binds to
//     undefined, which the entry state does not model);
//   - no nested function in the loop references a head name (a capture is
//     exactly what makes the per-iteration copies observable, and a captured
//     binding lives in a ref cell the raw head initialization would overwrite);
//   - a `let` head name is declared nowhere else in the function and is not a
//     parameter (spill slots are keyed by name, so a shadowing twin would share
//     the head's slot).
//
// Leaf module on purpose: only `ts-api` and pure AST helpers, so it stays
// outside the codegen import cycle (#6797 ratchet).
import type { ts as TsNs } from "../../ts-api.js";
import { forEachChild, ts } from "../../ts-api.js";
import { isNestedFunctionScope } from "../async-cps-ast.js";

/** A loop statement the async loop CFG can own. */
export type AsyncLoopStatement = TsNs.WhileStatement | TsNs.ForStatement | TsNs.DoStatement;

/** True for the three iteration statements the async loop CFG lowers. */
export function isAsyncLoopStatement(stmt: TsNs.Statement): stmt is AsyncLoopStatement {
  return ts.isWhileStatement(stmt) || ts.isForStatement(stmt) || ts.isDoStatement(stmt);
}

/** Names bound by an admissible `for` head declaration list, or null when it is off-shape. */
function forHeadNames(list: TsNs.VariableDeclarationList): { names: string[]; lexical: boolean } | null {
  const lexical = (list.flags & ts.NodeFlags.Let) !== 0;
  if ((list.flags & (ts.NodeFlags.Const | ts.NodeFlags.Using | ts.NodeFlags.AwaitUsing)) !== 0) return null;
  const names: string[] = [];
  for (const decl of list.declarations) {
    if (!ts.isIdentifier(decl.name)) return null;
    if (lexical && decl.initializer === undefined) return null;
    names.push(decl.name.text);
  }
  return { names, lexical };
}

/** How often each name is declared (params + declarators) in `fn`'s own scope. */
function declarationCounts(fn: TsNs.FunctionLikeDeclaration): Map<string, number> {
  const counts = new Map<string, number>();
  const bump = (name: TsNs.BindingName): void => {
    if (ts.isIdentifier(name)) {
      counts.set(name.text, (counts.get(name.text) ?? 0) + 1);
      return;
    }
    for (const element of name.elements) if (!ts.isOmittedExpression(element)) bump(element.name);
  };
  for (const p of fn.parameters) bump(p.name);
  const walk = (node: TsNs.Node): void => {
    if (isNestedFunctionScope(node)) return;
    if (ts.isVariableDeclaration(node)) bump(node.name);
    forEachChild(node, walk);
  };
  if (fn.body !== undefined) walk(fn.body);
  return counts;
}

/** True when a nested function scope inside `root` mentions any of `names`. */
function namesCapturedByNestedFunction(root: TsNs.Node, names: ReadonlySet<string>): boolean {
  let captured = false;
  const inside = (node: TsNs.Node): void => {
    if (captured) return;
    if (ts.isIdentifier(node) && names.has(node.text)) {
      captured = true;
      return;
    }
    forEachChild(node, inside);
  };
  const outside = (node: TsNs.Node): void => {
    if (captured) return;
    if (isNestedFunctionScope(node)) {
      inside(node);
      return;
    }
    forEachChild(node, outside);
  };
  outside(root);
  return captured;
}

/** (#7096) True when `stmt`'s head can be split across the loop CFG's states (rules above). */
export function asyncForHeadAdmissible(fn: TsNs.FunctionLikeDeclaration, stmt: TsNs.ForStatement): boolean {
  const init = stmt.initializer;
  if (init === undefined || !ts.isVariableDeclarationList(init)) return true;
  const head = forHeadNames(init);
  if (head === null) return false;
  if (namesCapturedByNestedFunction(stmt, new Set(head.names))) return false;
  if (!head.lexical) return true;
  const counts = declarationCounts(fn);
  return head.names.every((name) => counts.get(name) === 1);
}
