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
  // Trailing comma after a rest element: `[...x,] = y` — a SyntaxError (an
  // elision may not follow AssignmentRestElement). TS's parser accepts this
  // without inserting a trailing OmittedExpression, so detect it via the
  // NodeArray's hasTrailingComma flag when the last element is the rest.
  const lastElem = arr.elements[arr.elements.length - 1];
  if (arr.elements.hasTrailingComma && lastElem && ts.isSpreadElement(lastElem)) {
    ctx.addError(restNode ?? lastElem, "Rest element must be last in a destructuring pattern");
  }
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
  const lastProperty = obj.properties[obj.properties.length - 1];
  for (const prop of obj.properties) {
    if (ts.isSpreadAssignment(prop)) {
      // AssignmentRestProperty (`...rest`) must be LAST — no property may follow
      // it (`({...rest, b} = y)`). TS accepts spread-not-last silently, so flag it.
      if (prop !== lastProperty) {
        ctx.addError(prop, "Rest element must be last in a destructuring pattern");
      }
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
  // Trailing comma after an object rest property: `({...x,} = y)` — a
  // SyntaxError (AssignmentRestProperty must be last, no trailing comma).
  const lastProp = obj.properties[obj.properties.length - 1];
  if (obj.properties.hasTrailingComma && lastProp && ts.isSpreadAssignment(lastProp)) {
    ctx.addError(lastProp, "Rest element must be last in a destructuring pattern");
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
  // (#6491 r2) A MetaProperty — `import.meta`, `new.target` — has
  // AssignmentTargetType ~invalid~ in every goal and every dialect, so it can
  // never be a DestructuringAssignmentTarget (§13.15.1). The four
  // `import.meta/syntax/invalid-assignment-target-*` rows land here:
  // `[import.meta] = []`, `({a: import.meta} = {})` and the two rest forms all
  // reach this validator with the MetaProperty as the element target, and the
  // permissive tail below accepted them.
  //
  // Deliberately the ONLY kind added to that tail. The tail is permissive on
  // purpose — a general "every element must be a simple target" rule would also
  // have to model TS-only wrappers (`as`, `satisfies`, type assertions) that
  // erase at emit, and getting that wrong rejects valid product code. A
  // MetaProperty needs no such judgement: there is no dialect in which it is
  // assignable. The general element-validation gap (`[this] = []`,
  // `[a + b] = []` are still accepted) is recorded in #6491 as not fixed.
  if (ts.isMetaProperty(target)) {
    const meta = target.keywordToken === ts.SyntaxKind.ImportKeyword ? "import.meta" : "new.target";
    ctx.addError(expr, `Invalid destructuring assignment target '${meta}'`);
  }
}
