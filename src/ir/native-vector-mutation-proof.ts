// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../ts-api.js";

export function nativeVectorMutationOwnerIsSynchronous(node: ts.Node): boolean {
  let owner: ts.Node | undefined = node.parent;
  while (owner && !ts.isFunctionLike(owner)) owner = owner.parent;
  return (
    owner !== undefined &&
    ts.isFunctionDeclaration(owner) &&
    !owner.asteriskToken &&
    !owner.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
  );
}

/** A body-only counted-loop write proof. Textual read proofs grant no store authority. */
export function nativeVectorMutationIsProven(
  access: ts.ElementAccessExpression,
  checker: ts.TypeChecker | undefined,
  vectorExpression: (expression: ts.Expression) => boolean,
): boolean {
  if (!checker || !ts.isIdentifier(access.expression) || !ts.isIdentifier(access.argumentExpression)) return false;
  if (!nativeVectorMutationOwnerIsSynchronous(access)) return false;
  const receiver = checker.getSymbolAtLocation(access.expression);
  const index = checker.getSymbolAtLocation(access.argumentExpression);
  if (!receiver || !index || receiver === index) return false;
  let child: ts.Node = access;
  for (let node = access.parent; node; child = node, node = node.parent) {
    if (ts.isFunctionLike(node)) return false;
    if (!ts.isForStatement(node) || child !== node.statement) continue;
    const condition = node.condition;
    if (!condition || !ts.isBinaryExpression(condition)) continue;
    const left = condition.operatorToken.kind === ts.SyntaxKind.LessThanToken ? condition.left : condition.right;
    const right = condition.operatorToken.kind === ts.SyntaxKind.LessThanToken ? condition.right : condition.left;
    if (
      ![ts.SyntaxKind.LessThanToken, ts.SyntaxKind.GreaterThanToken].includes(condition.operatorToken.kind) ||
      !ts.isIdentifier(left) ||
      checker.getSymbolAtLocation(left) !== index ||
      !ts.isPropertyAccessExpression(right) ||
      right.name.text !== "length" ||
      !ts.isIdentifier(right.expression) ||
      checker.getSymbolAtLocation(right.expression) !== receiver
    )
      continue;
    const head = node.initializer;
    if (
      !head ||
      !ts.isVariableDeclarationList(head) ||
      head.declarations.length !== 1 ||
      (head.flags & ts.NodeFlags.Let) === 0
    )
      return false;
    const declaration = head.declarations[0];
    if (
      !ts.isIdentifier(declaration.name) ||
      checker.getSymbolAtLocation(declaration.name) !== index ||
      !declaration.initializer ||
      !ts.isNumericLiteral(declaration.initializer)
    )
      return false;
    const initial = Number(declaration.initializer.text.replace(/_/g, ""));
    if (!Number.isInteger(initial) || initial < 0 || initial > 2147483647) return false;
    const update = node.incrementor;
    if (
      !update ||
      (!ts.isPrefixUnaryExpression(update) && !ts.isPostfixUnaryExpression(update)) ||
      update.operator !== ts.SyntaxKind.PlusPlusToken ||
      !ts.isIdentifier(update.operand) ||
      checker.getSymbolAtLocation(update.operand) !== index
    )
      return false;
    return stableBody(node.statement, checker, receiver, index, vectorExpression);
  }
  return false;
}

function stableBody(
  body: ts.Statement,
  checker: ts.TypeChecker,
  receiver: ts.Symbol,
  index: ts.Symbol,
  vectorExpression: (expression: ts.Expression) => boolean,
): boolean {
  let stable = true;
  const stableTarget = (target: ts.Expression): boolean => {
    if (ts.isIdentifier(target)) {
      const symbol = checker.getSymbolAtLocation(target);
      return symbol !== undefined && symbol !== receiver && symbol !== index;
    }
    return (
      ts.isElementAccessExpression(target) &&
      ts.isIdentifier(target.expression) &&
      ts.isIdentifier(target.argumentExpression) &&
      checker.getSymbolAtLocation(target.expression) === receiver &&
      checker.getSymbolAtLocation(target.argumentExpression) === index
    );
  };
  const visit = (node: ts.Node): void => {
    if (!stable) return;
    // Object/any coercion can invoke user code without a call expression in the body.
    if (ts.isIdentifier(node) && !vectorExpression(node)) {
      const primitive = ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike | ts.TypeFlags.StringLike;
      if ((checker.getTypeAtLocation(node).flags & primitive) === 0) {
        stable = false;
        return;
      }
    }
    // Only genuine logical-vector reads have effect-free native property semantics.
    if (
      (ts.isElementAccessExpression(node) && !vectorExpression(node.expression)) ||
      (ts.isPropertyAccessExpression(node) && (node.name.text !== "length" || !vectorExpression(node.expression)))
    ) {
      stable = false;
      return;
    }
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (!ts.isIdentifier(node.name)) {
        stable = false;
        return;
      }
      const symbol = checker.getSymbolAtLocation(node.name);
      if (symbol === receiver || symbol === index) {
        stable = false;
        return;
      }
    }
    // Unknown call effects and property writes may shorten a vector through an alias.
    if (
      ts.isCallExpression(node) ||
      ts.isNewExpression(node) ||
      ts.isTaggedTemplateExpression(node) ||
      ts.isAwaitExpression(node) ||
      ts.isYieldExpression(node) ||
      ts.isDeleteExpression(node) ||
      ts.isFunctionLike(node) ||
      ts.isClassLike(node)
    ) {
      stable = false;
      return;
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      !stableTarget(node.left)
    ) {
      stable = false;
      return;
    }
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) &&
      !stableTarget(node.operand)
    ) {
      stable = false;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return stable;
}
