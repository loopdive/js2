// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// AssignmentPattern (destructuring assignment target) early-error rules
// (#1931). Extracted verbatim from detectEarlyErrors; the only change is
// threading an EarlyErrorContext through the mutually-recursive validators.
import { ts } from "../../ts-api.js";
import type { EarlyErrorContext } from "./context.js";

/**
 * Validate an ArrayLiteralExpression used as an assignment pattern (LHS of =, for-of, for-in).
 * ES spec: ArrayAssignmentPattern restrictions:
 * - Rest element (...x) must be last — no elements may follow
 * - No trailing comma after rest (treated as elision after rest = error)
 * - Rest element may not have an initializer (= default) — e.g. [...x = 1] = []
 * - Each element must be a valid DestructuringAssignmentTarget
 * - Comma expressions (x, y) are not valid element targets
 * Strict mode: eval/arguments cannot appear as identifiers in assignment targets
 */
export function validateArrayAssignmentPattern(
  ctx: EarlyErrorContext,
  arr: ts.ArrayLiteralExpression,
  strict: boolean,
): void {
  let foundRest = false;
  let restNode: ts.Node | undefined;
  for (let i = 0; i < arr.elements.length; i++) {
    const elem = arr.elements[i];
    // Elision (omitted element, e.g. [, x]) — valid unless after rest
    if (elem.kind === ts.SyntaxKind.OmittedExpression) {
      if (foundRest) {
        ctx.addError(restNode ?? elem, "Rest element must be last in a destructuring pattern");
      }
      continue;
    }
    if (ts.isSpreadElement(elem)) {
      if (foundRest) {
        ctx.addError(elem, "Rest element must be last in a destructuring pattern");
      }
      foundRest = true;
      restNode = elem;
      // Rest element with initializer: [...x = 1] — not valid
      const restExpr = elem.expression;
      if (ts.isBinaryExpression(restExpr) && restExpr.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        ctx.addError(elem, "Rest element may not have a default initializer");
      }
      // Validate the rest target itself
      validateAssignmentTarget(ctx, restExpr, strict);
    } else {
      if (foundRest) {
        ctx.addError(elem, "Rest element must be last in a destructuring pattern");
      }
      // Each element is an AssignmentElement: target (= default)?
      // Extract target and initializer
      let target: ts.Expression = elem;
      if (ts.isBinaryExpression(elem) && elem.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        target = elem.left;
        // Validate default value for yield/await issues if needed
      }
      validateAssignmentTarget(ctx, target, strict);
    }
  }
  // If there's a trailing comma after a rest, it creates an elision — already caught above.
  // But TS may also insert an OmittedExpression at the end for trailing commas.
  // The check above handles it via "elision after rest".
}

/**
 * Validate an ObjectLiteralExpression used as an assignment pattern.
 * ES spec: ObjectAssignmentPattern restrictions:
 * - Methods (shorthand methods, getters, setters) are not valid property values
 * - Each property value must be a valid assignment target
 * Strict mode: eval/arguments as shorthand names are errors
 */
export function validateObjectAssignmentPattern(
  ctx: EarlyErrorContext,
  obj: ts.ObjectLiteralExpression,
  strict: boolean,
): void {
  for (const prop of obj.properties) {
    if (ts.isSpreadAssignment(prop)) {
      // Rest in object: { ...rest } = x — valid, but rest may not have computed
      validateAssignmentTarget(ctx, prop.expression, strict);
      continue;
    }
    if (ts.isShorthandPropertyAssignment(prop)) {
      // { x } = obj or { x = default } = obj
      if (strict) {
        const name = prop.name.text;
        if (name === "eval" || name === "arguments") {
          ctx.addError(prop.name, `Binding '${name}' in strict mode is not allowed`);
        }
      }
      continue;
    }
    if (ts.isPropertyAssignment(prop)) {
      // { key: value } = obj
      validateAssignmentTarget(ctx, prop.initializer, strict);
      continue;
    }
    // Shorthand methods, getters, setters are always invalid in assignment patterns
    if (ts.isMethodDeclaration(prop) || ts.isGetAccessorDeclaration(prop) || ts.isSetAccessorDeclaration(prop)) {
      ctx.addError(prop, "Method definitions are not allowed in assignment patterns");
    }
  }
}

/**
 * Validate a single assignment target in a destructuring position.
 * Flags: comma expressions, getter/setter as targets, invalid simple targets.
 */
export function validateAssignmentTarget(ctx: EarlyErrorContext, expr: ts.Expression, strict: boolean): void {
  // Unwrap parentheses
  let target: ts.Node = expr;
  while (ts.isParenthesizedExpression(target)) target = (target as ts.ParenthesizedExpression).expression;

  // Comma expression is never a valid assignment target
  if (ts.isBinaryExpression(target) && target.operatorToken.kind === ts.SyntaxKind.CommaToken) {
    ctx.addError(expr, "Invalid destructuring assignment target");
    return;
  }
  // Nested array pattern
  if (ts.isArrayLiteralExpression(target)) {
    validateArrayAssignmentPattern(ctx, target, strict);
    return;
  }
  // Nested object pattern
  if (ts.isObjectLiteralExpression(target)) {
    validateObjectAssignmentPattern(ctx, target, strict);
    return;
  }
  // Binary assignment with default value: target = default
  if (ts.isBinaryExpression(target) && target.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    validateAssignmentTarget(ctx, target.left, strict);
    return;
  }
  // Simple targets: identifiers, property access, element access
  if (ts.isIdentifier(target)) {
    if (strict && (target.text === "eval" || target.text === "arguments")) {
      ctx.addError(target, `Invalid assignment target '${target.text}' in strict mode`);
    }
    return;
  }
  if (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) {
    return;
  }
}
