// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../../ts-api.js";
import type { CodegenContext } from "../context/types.js";

function isIgnoredArgumentsIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (
    (ts.isVariableDeclaration(parent) || ts.isBindingElement(parent) || ts.isParameter(parent)) &&
    parent.name === node
  ) {
    return true;
  }
  return (
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    (ts.isPropertyAssignment(parent) && parent.name === node) ||
    (ts.isMethodDeclaration(parent) && parent.name === node) ||
    (ts.isPropertyDeclaration(parent) && parent.name === node) ||
    (ts.isGetAccessorDeclaration(parent) && parent.name === node) ||
    (ts.isSetAccessorDeclaration(parent) && parent.name === node)
  );
}

function isMutatingOrReceiverUse(access: ts.Expression): boolean {
  let current: ts.Node = access;
  for (;;) {
    const parent = current.parent;
    if (
      ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isNonNullExpression(parent) ||
      ts.isTypeAssertionExpression(parent)
    ) {
      current = parent;
      continue;
    }
    if (
      ts.isArrayLiteralExpression(parent) ||
      ts.isObjectLiteralExpression(parent) ||
      ts.isPropertyAssignment(parent) ||
      ts.isSpreadElement(parent) ||
      ts.isSpreadAssignment(parent)
    ) {
      current = parent;
      continue;
    }
    break;
  }
  const parent = current.parent;
  if (
    ts.isBinaryExpression(parent) &&
    parent.left === current &&
    parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  ) {
    return true;
  }
  if ((ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) && parent.operand === current) {
    return true;
  }
  if (ts.isDeleteExpression(parent) && parent.expression === current) return true;
  if ((ts.isForInStatement(parent) || ts.isForOfStatement(parent)) && parent.initializer === current) return true;
  // `arguments[0]()` observes the arguments object as the call receiver.
  if (ts.isCallExpression(parent) && parent.expression === current) return true;
  if (ts.isTaggedTemplateExpression(parent) && parent.tag === current) return true;
  return false;
}

function isProvenNumericIndex(ctx: CodegenContext, expression: ts.Expression): boolean {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  if (ts.isNumericLiteral(current)) return true;
  if (ts.isIdentifier(current)) {
    const declaration = ctx.oracle.valueDeclarationOf(current);
    if (declaration && ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name)) {
      // Query the declaration, not the element-access use: contextual typing
      // from `arguments[...]` can make a string key appear numeric at the use.
      if (declaration.type && declaration.type.kind !== ts.SyntaxKind.NumberKeyword) return false;
      const initializer = declaration.initializer;
      const numericInitializer =
        initializer !== undefined &&
        (ts.isNumericLiteral(initializer) ||
          ((ts.isPrefixUnaryExpression(initializer) || ts.isParenthesizedExpression(initializer)) &&
            ctx.oracle.typeFactOf(initializer).kind === "number"));
      return (
        (declaration.type?.kind === ts.SyntaxKind.NumberKeyword || numericInitializer) &&
        ctx.oracle.typeFactOf(declaration.name).kind === "number"
      );
    }
    if (declaration && ts.isParameter(declaration) && ts.isIdentifier(declaration.name)) {
      return (
        declaration.type?.kind === ts.SyntaxKind.NumberKeyword &&
        ctx.oracle.typeFactOf(declaration.name).kind === "number"
      );
    }
    return false;
  }
  return ctx.oracle.typeFactOf(current).kind === "number";
}

/**
 * Whether an implicit arguments object needs host registration.
 *
 * A private object used only for `.length` and numeric indexed reads never
 * crosses the Wasm boundary and never observes its prototype, descriptors, or
 * `callee`. Its vec representation already implements those two reads directly,
 * so registering it in the host WeakSet is unnecessary. Every other use stays
 * on the conservative registered path.
 */
export function bodyRequiresArgumentsHostRegistration(ctx: CodegenContext, body: ts.Node): boolean {
  const stack: ts.Node[] = [body];
  while (stack.length > 0) {
    const node = stack.pop()!;

    // Normal nested functions bind their own `arguments`; arrows inherit it.
    // A method/accessor's computed NAME is the exception: it is evaluated
    // while the containing object/class is defined, in the outer function's
    // scope. Visit that expression, but never the nested callable's parameters
    // or body.
    if (ts.isFunctionLike(node) && !ts.isArrowFunction(node)) {
      if (
        (ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) &&
        ts.isComputedPropertyName(node.name)
      ) {
        stack.push(node.name.expression);
      }
      continue;
    }
    if (ts.isWithStatement(node)) return true;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "eval") return true;

    if (ts.isIdentifier(node) && node.text === "arguments" && !isIgnoredArgumentsIdentifier(node)) {
      const parent = node.parent;
      if (
        ts.isPropertyAccessExpression(parent) &&
        parent.expression === node &&
        parent.name.text === "length" &&
        !isMutatingOrReceiverUse(parent)
      ) {
        continue;
      }
      if (
        ts.isElementAccessExpression(parent) &&
        parent.expression === node &&
        isProvenNumericIndex(ctx, parent.argumentExpression) &&
        !isMutatingOrReceiverUse(parent)
      ) {
        continue;
      }
      return true;
    }

    node.forEachChild((child) => {
      stack.push(child);
    });
  }
  return false;
}

export function shouldRegisterArgumentsWithHost(
  ctx: CodegenContext,
  body: ts.Node,
  reachesDirectEval: boolean,
): boolean {
  return (
    reachesDirectEval ||
    process.env.JS2WASM_ELIDE_PRIVATE_ARGUMENTS_REGISTRATION === "0" ||
    bodyRequiresArgumentsHostRegistration(ctx, body)
  );
}
