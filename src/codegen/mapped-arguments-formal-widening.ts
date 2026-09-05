// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";
import { needsImplicitArgumentsObject } from "./helpers/body-uses-arguments.js";
import { isSimpleParameterList, isStrictFunction } from "./helpers/is-strict-function.js";

function staticArgumentIndex(expr: ts.Expression): number | undefined {
  if (!ts.isNumericLiteral(expr) && !ts.isStringLiteral(expr)) return undefined;
  const index = Number(expr.text);
  return Number.isInteger(index) && index >= 0 && String(index) === expr.text ? index : undefined;
}

function isObjectDefineProperty(expr: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === "Object" &&
    expr.name.text === "defineProperty"
  );
}

function isNumericValue(ctx: CodegenContext, expr: ts.Expression): boolean {
  return ctx.oracle.staticJsTypeOf(expr) === "number";
}

/**
 * Whether a mapped formal can receive a value outside its inferred numeric
 * carrier through the function's own arguments object. This intentionally
 * recognizes only direct, statically indexed writes: widening an entire
 * closure ABI for an aliased or dynamic object would make the repair much
 * broader than the measured descriptor row.
 */
export function mappedFormalNeedsExternref(
  ctx: CodegenContext,
  fn: ts.FunctionLikeDeclaration,
  index: number,
): boolean {
  // Arrow functions inherit `arguments` and therefore cannot own a mapped
  // arguments object for this formal. Closure inference visits arrows too, so
  // reject them before the shared `needsImplicitArgumentsObject` predicate.
  if (ts.isArrowFunction(fn)) return false;
  const gate = fn.body === undefined;
  const needs = needsImplicitArgumentsObject(fn, ctx.inferModuleStrictArguments);
  const simple = isSimpleParameterList(fn.parameters);
  const strict = isStrictFunction(fn, ctx.inferModuleStrictArguments);
  if (gate || !needs || !simple || strict) {
    return false;
  }

  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    // Nested ordinary functions (including methods/accessors) own their own
    // `arguments`; nested arrows inherit this function's binding and remain
    // part of the direct-write scan.
    if (ts.isFunctionLike(node) && !ts.isArrowFunction(node)) return;

    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const left = node.left;
      if (
        ts.isElementAccessExpression(left) &&
        ts.isIdentifier(left.expression) &&
        left.expression.text === "arguments" &&
        staticArgumentIndex(left.argumentExpression) === index &&
        !isNumericValue(ctx, node.right)
      ) {
        found = true;
        return;
      }
    }

    if (ts.isCallExpression(node) && isObjectDefineProperty(node.expression) && node.arguments.length >= 3) {
      const receiver = node.arguments[0];
      const key = staticArgumentIndex(node.arguments[1]!);
      if (ts.isIdentifier(receiver) && receiver.text === "arguments" && key === index) {
        const descriptor = node.arguments[2]!;
        if (!ts.isObjectLiteralExpression(descriptor)) {
          found = true;
          return;
        }
        let hasValue = false;
        for (const property of descriptor.properties) {
          if (ts.isSpreadAssignment(property)) {
            found = true;
            return;
          }
          const name = property.name;
          const propertyName =
            name && (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name))
              ? name.text
              : undefined;
          if (propertyName !== "value") continue;
          if (ts.isPropertyAssignment(property)) {
            hasValue = true;
            if (!isNumericValue(ctx, property.initializer)) {
              found = true;
              return;
            }
          } else if (ts.isShorthandPropertyAssignment(property)) {
            hasValue = true;
            if (!isNumericValue(ctx, property.name)) {
              found = true;
              return;
            }
          }
        }
        if (hasValue) return;
      }
    }

    node.forEachChild(visit);
  };
  visit(fn.body);
  return found;
}
