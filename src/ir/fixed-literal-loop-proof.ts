// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { loopBodyMutatesIndexOrArray, isIncreasingStep } from "./analysis/loop-shape.js";
import { ts } from "../ts-api.js";

/** Prove that a counted-loop index starts at a non-negative numeric literal. */
export function forInitsIndexNonNegative(stmt: ts.ForStatement, indexVar: string): boolean {
  const init = stmt.initializer;
  if (!init || !ts.isVariableDeclarationList(init)) return false;
  for (const decl of init.declarations) {
    if (ts.isIdentifier(decl.name) && decl.name.text === indexVar) {
      const initial = decl.initializer;
      if (initial && ts.isNumericLiteral(initial)) {
        const value = Number(initial.text.replace(/_/g, ""));
        return Number.isFinite(value) && value >= 0;
      }
      return false;
    }
  }
  return false;
}

/**
 * Prove fixed-literal reads in a numeric-bound counted loop. The array binding
 * must be a same-function `const` initialized by a dense literal, and every use
 * must remain a read-only element access or `.length` observation.
 */
export function detectFixedLiteralLoopSafeIndexes(
  stmt: ts.ForStatement,
  checker: ts.TypeChecker | undefined,
): readonly string[] {
  const condition = stmt.condition;
  if (!checker || !condition || !ts.isBinaryExpression(condition)) return [];
  const op = condition.operatorToken.kind;
  const indexExpr = op === ts.SyntaxKind.LessThanToken ? condition.left : condition.right;
  const boundExpr = op === ts.SyntaxKind.LessThanToken ? condition.right : condition.left;
  if (
    (op !== ts.SyntaxKind.LessThanToken && op !== ts.SyntaxKind.GreaterThanToken) ||
    !ts.isIdentifier(indexExpr) ||
    !ts.isNumericLiteral(boundExpr)
  ) {
    return [];
  }
  const bound = Number(boundExpr.text.replace(/_/g, ""));
  const indexName = indexExpr.text;
  if (!Number.isSafeInteger(bound) || bound < 0) return [];
  if (!forInitsIndexNonNegative(stmt, indexName) || !isIncreasingStep(stmt.incrementor, indexName)) return [];

  let owner: ts.Node | undefined = stmt.parent;
  while (owner && !ts.isFunctionLike(owner)) owner = owner.parent;
  if (!owner || !("body" in owner) || !owner.body) return [];
  const ownerBody = owner.body as ts.ConciseBody;

  const candidateNames = new Set<string>();
  let nestedRuntime = false;
  const collectReads = (node: ts.Node): void => {
    if (nestedRuntime) return;
    if (node !== stmt.statement && (ts.isFunctionLike(node) || ts.isClassLike(node))) {
      nestedRuntime = true;
      return;
    }
    if (
      ts.isElementAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      ts.isIdentifier(node.argumentExpression) &&
      node.argumentExpression.text === indexName
    ) {
      candidateNames.add(node.expression.text);
    }
    ts.forEachChild(node, collectReads);
  };
  collectReads(stmt.statement);
  if (nestedRuntime || candidateNames.size === 0) return [];

  const safe: string[] = [];
  for (const arrayName of candidateNames) {
    if (loopBodyMutatesIndexOrArray(stmt.statement, indexName, arrayName)) continue;
    let candidateSymbol: ts.Symbol | undefined;
    const findCandidate = (node: ts.Node): void => {
      if (candidateSymbol || !ts.isElementAccessExpression(node)) {
        if (!candidateSymbol) ts.forEachChild(node, findCandidate);
        return;
      }
      if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === arrayName &&
        ts.isIdentifier(node.argumentExpression) &&
        node.argumentExpression.text === indexName
      ) {
        candidateSymbol = checker.getSymbolAtLocation(node.expression);
      }
    };
    findCandidate(stmt.statement);
    const declaration = candidateSymbol?.valueDeclaration;
    if (
      !candidateSymbol ||
      !declaration ||
      !ts.isVariableDeclaration(declaration) ||
      !ts.isIdentifier(declaration.name) ||
      !ts.isVariableDeclarationList(declaration.parent) ||
      (declaration.parent.flags & ts.NodeFlags.Const) === 0 ||
      !declaration.initializer ||
      !ts.isArrayLiteralExpression(declaration.initializer) ||
      declaration.initializer.elements.some(ts.isSpreadElement) ||
      declaration.initializer.elements.some(ts.isOmittedExpression) ||
      declaration.initializer.elements.length < bound
    ) {
      continue;
    }
    let declarationOwner: ts.Node | undefined = declaration.parent;
    while (declarationOwner && !ts.isFunctionLike(declarationOwner)) declarationOwner = declarationOwner.parent;
    if (declarationOwner !== owner) continue;

    let unsafeUse = false;
    const visitUses = (node: ts.Node): void => {
      if (unsafeUse) return;
      if (node !== owner && (ts.isFunctionLike(node) || ts.isClassLike(node))) return;
      if (ts.isIdentifier(node) && checker.getSymbolAtLocation(node) === candidateSymbol) {
        if (node === declaration.name) return;
        const parent = node.parent;
        if (ts.isElementAccessExpression(parent) && parent.expression === node) {
          const grandparent = parent.parent;
          if (
            (ts.isBinaryExpression(grandparent) && grandparent.left === parent) ||
            ts.isPrefixUnaryExpression(grandparent) ||
            ts.isPostfixUnaryExpression(grandparent)
          ) {
            unsafeUse = true;
          }
          return;
        }
        if (
          ts.isPropertyAccessExpression(parent) &&
          parent.expression === node &&
          parent.name.text === "length" &&
          !(ts.isBinaryExpression(parent.parent) && parent.parent.left === parent)
        ) {
          return;
        }
        unsafeUse = true;
        return;
      }
      ts.forEachChild(node, visitUses);
    };
    ts.forEachChild(ownerBody, visitUses);
    if (!unsafeUse) safe.push(`${arrayName}:${indexName}`);
  }
  return safe;
}

/**
 * #2766 — the counted-loop in-bounds proof for the IR. Returns the
 * `"arrayVar:indexVar"` key when the `for` provably keeps its index in
 * `[0, array.length)` across the whole body, else `null`.
 *
 * This is a *real* proof (per the hybrid invariant — a compiler-checked fact,
 * not the mere presence of a `: number[]` type), and it is intentionally
 * STRICTER than legacy's `safeIndexedArrays` population (which checked only the
 * `i < arr.length` condition + body non-mutation): the IR fast path emits an
 * UNCHECKED `array.get` that *traps* on OOB, so the proof must also pin the lower
 * bound. We therefore additionally require a non-negative-literal init and a
 * strictly-increasing step, giving `0 <= i` at entry, `i` only increases, and
 * the strict `i < arr.length` condition ⇒ `0 <= i < arr.length` at every body
 * point. Anything not fully proven returns `null` and gets the SAFE read.
 */
export function detectCountedLoopSafeIndex(stmt: ts.ForStatement): string | null {
  if (!stmt.condition || !ts.isBinaryExpression(stmt.condition)) return null;
  const cond = stmt.condition;
  const op = cond.operatorToken.kind;
  let indexExpr: ts.Expression | undefined;
  let lengthExpr: ts.Expression | undefined;
  // Strict `i < arr.length`
  if (op === ts.SyntaxKind.LessThanToken) {
    indexExpr = cond.left;
    lengthExpr = cond.right;
  } else if (op === ts.SyntaxKind.GreaterThanToken) {
    // Strict `arr.length > i`
    indexExpr = cond.right;
    lengthExpr = cond.left;
  } else {
    return null; // `<=` / `>=` would admit `i == arr.length` (OOB)
  }
  if (
    !indexExpr ||
    !lengthExpr ||
    !ts.isIdentifier(indexExpr) ||
    !ts.isPropertyAccessExpression(lengthExpr) ||
    !ts.isIdentifier(lengthExpr.name) ||
    lengthExpr.name.text !== "length" ||
    !ts.isIdentifier(lengthExpr.expression)
  ) {
    return null;
  }
  const indexVar = indexExpr.text;
  const arrayVar = lengthExpr.expression.text;
  // Lower bound: i starts >= 0 and strictly increases.
  if (!forInitsIndexNonNegative(stmt, indexVar)) return null;
  if (!isIncreasingStep(stmt.incrementor, indexVar)) return null;
  // Stability: body must not reassign i / arr / arr.length, call a method on arr
  // (could change length), or contain a nested function (could capture+mutate).
  if (loopBodyMutatesIndexOrArray(stmt.statement, indexVar, arrayVar)) return null;
  return arrayVar + ":" + indexVar;
}

/**
 * (#7346) Whether an enclosing counted loop's proof covers `expr` (`s[i]` in
 * the body of `for (let i = 0; i < s.length; i++)`): from-ast's
 * `isProvenInBoundsIr` witness for this pair, read off the AST by the
 * selector.
 */
export function countedLoopProvesElementRead(expr: ts.ElementAccessExpression): boolean {
  if (!ts.isIdentifier(expr.expression) || !ts.isIdentifier(expr.argumentExpression)) return false;
  const pair = expr.expression.text + ":" + expr.argumentExpression.text;
  for (let node: ts.Node = expr; !ts.isSourceFile(node.parent); node = node.parent) {
    if (ts.isFunctionLike(node.parent)) return false;
    if (
      ts.isForStatement(node.parent) &&
      node.parent.statement === node &&
      detectCountedLoopSafeIndex(node.parent) === pair
    )
      return true;
  }
  return false;
}
