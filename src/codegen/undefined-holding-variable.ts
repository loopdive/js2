// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#1058) A `let`/`var` whose declared type admits neither `null` nor
// `undefined` can still HOLD `undefined`: it was declared without an
// initializer, or the program resets it with `undefined!`. The TypeScript
// binder does both to its per-file state:
//
//     let jsDocImports: JSDocImportTag[];      // undefined until a file sets it
//     ...
//     jsDocImports = undefined!;               // reset after each bind
//     if (jsDocImports === undefined) return;  // folded to `false` → for-of on null
//
// The nullish-comparison ref arm in `binary-ops.ts` folds `x === undefined` to
// `false` for such a carrier, because the checker reports the declared type.
// This predicate names the carrier whose `ref.null` may be that `undefined`, so
// the comparison keeps its runtime `ref.is_null` test instead. It is a claim
// about the carrier, never a fold: a variable that holds a real value tests
// false exactly as before.

import { ts } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";

const undefinedHoldingCache = new WeakMap<ts.VariableDeclaration, boolean>();

/** `undefined`, `undefined!`, `undefined as T`, `(undefined)`, `void 0`. */
function isUndefinedShaped(expr: ts.Expression): boolean {
  let e = expr;
  while (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isAsExpression(e)) e = e.expression;
  return (ts.isIdentifier(e) && e.text === "undefined") || ts.isVoidExpression(e);
}

function typeAdmitsNullish(typeNode: ts.TypeNode): boolean {
  const isNullish = (node: ts.TypeNode): boolean =>
    node.kind === ts.SyntaxKind.NullKeyword ||
    node.kind === ts.SyntaxKind.UndefinedKeyword ||
    (ts.isLiteralTypeNode(node) && node.literal.kind === ts.SyntaxKind.NullKeyword);
  return isNullish(typeNode) || (ts.isUnionTypeNode(typeNode) && typeNode.types.some(isNullish));
}

/** Does the declaration's scope assign an undefined-shaped value to `name`? */
function scopeAssignsUndefined(scope: ts.Node, name: string): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      node.left.text === name &&
      isUndefinedShaped(node.right)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(scope);
  return found;
}

function computeUndefinedHolding(declaration: ts.VariableDeclaration): boolean {
  if (!ts.isIdentifier(declaration.name) || declaration.type === undefined) return false;
  const list = declaration.parent;
  if (!ts.isVariableDeclarationList(list) || (list.flags & ts.NodeFlags.Const) !== 0) return false;
  // `for (let x of …)` / `for (let x in …)` always binds a value.
  if (ts.isForOfStatement(list.parent) || ts.isForInStatement(list.parent)) return false;
  if (typeAdmitsNullish(declaration.type)) return false; // the union test already handles it
  if (declaration.initializer === undefined) return true;
  const scope = list.parent?.parent ?? list.parent;
  return scope !== undefined && scopeAssignsUndefined(scope, declaration.name.text);
}

/**
 * Is `expr` a read of a mutable variable whose declared type excludes nullish
 * values but whose storage may still hold `undefined` (no initializer, or an
 * explicit `= undefined!` reset in its scope)?
 */
export function readsUndefinedHoldingVariable(ctx: CodegenContext, expr: ts.Expression): boolean {
  if (!ts.isIdentifier(expr)) return false;
  const declaration = ctx.oracle.variableDeclarationOf(expr);
  if (declaration === undefined) return false;
  let holds = undefinedHoldingCache.get(declaration);
  if (holds === undefined) {
    holds = computeUndefinedHolding(declaration);
    undefinedHoldingCache.set(declaration, holds);
  }
  return holds;
}
