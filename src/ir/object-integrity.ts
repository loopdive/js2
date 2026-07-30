// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { forEachChild, ts } from "../ts-api.js";

const ES5_INTRINSIC_OBJECTS: ReadonlySet<string> = new Set([
  "Object",
  "Function",
  "Array",
  "String",
  "Boolean",
  "Number",
  "Math",
  "Date",
  "RegExp",
  "Error",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
  "JSON",
]);

const ES5_INTRINSIC_PROTOTYPES: ReadonlySet<string> = new Set([
  "Object",
  "Function",
  "Array",
  "String",
  "Boolean",
  "Number",
  "Date",
  "RegExp",
  "Error",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
]);

const INTEGRITY_MUTATORS: ReadonlySet<string> = new Set(["freeze", "seal", "preventExtensions"]);
const sourceIntegrityMutationCache = new WeakMap<ts.SourceFile, boolean>();

function unwrapExpression(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return (
    kind === ts.SyntaxKind.EqualsToken ||
    kind === ts.SyntaxKind.PlusEqualsToken ||
    kind === ts.SyntaxKind.MinusEqualsToken ||
    kind === ts.SyntaxKind.AsteriskEqualsToken ||
    kind === ts.SyntaxKind.SlashEqualsToken ||
    kind === ts.SyntaxKind.PercentEqualsToken ||
    kind === ts.SyntaxKind.AsteriskAsteriskEqualsToken ||
    kind === ts.SyntaxKind.LessThanLessThanEqualsToken ||
    kind === ts.SyntaxKind.GreaterThanGreaterThanEqualsToken ||
    kind === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken ||
    kind === ts.SyntaxKind.AmpersandEqualsToken ||
    kind === ts.SyntaxKind.BarEqualsToken ||
    kind === ts.SyntaxKind.CaretEqualsToken ||
    kind === ts.SyntaxKind.QuestionQuestionEqualsToken ||
    kind === ts.SyntaxKind.AmpersandAmpersandEqualsToken ||
    kind === ts.SyntaxKind.BarBarEqualsToken
  );
}

function propertyNameText(node: ts.Node): string | undefined {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return node.text;
  return undefined;
}

function sourceMayMutateIntegrity(sourceFile: ts.SourceFile): boolean {
  const cached = sourceIntegrityMutationCache.get(sourceFile);
  if (cached !== undefined) return cached;

  let mayMutate = false;
  const visit = (node: ts.Node): void => {
    if (mayMutate) return;

    // Treat even taking a reference to an integrity mutator as unsafe. This
    // covers aliases such as `const freeze = Object.freeze; freeze(Boolean)`.
    if (
      (ts.isPropertyAccessExpression(node) && INTEGRITY_MUTATORS.has(node.name.text)) ||
      (ts.isElementAccessExpression(node) &&
        node.argumentExpression !== undefined &&
        INTEGRITY_MUTATORS.has(propertyNameText(node.argumentExpression) ?? ""))
    ) {
      mayMutate = true;
      return;
    }

    if (ts.isIdentifier(node) && INTEGRITY_MUTATORS.has(node.text)) {
      mayMutate = true;
      return;
    }

    if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) {
      const left = unwrapExpression(node.left as ts.Expression);
      if (
        (ts.isIdentifier(left) && left.text === "Object") ||
        (ts.isPropertyAccessExpression(left) &&
          ts.isIdentifier(left.expression) &&
          left.expression.text === "Object" &&
          left.name.text === "isFrozen")
      ) {
        mayMutate = true;
        return;
      }
    }

    forEachChild(node, visit);
  };
  visit(sourceFile);
  sourceIntegrityMutationCache.set(sourceFile, mayMutate);
  return mayMutate;
}

function isEs5IntrinsicObject(expr: ts.Expression, isAmbientBinding: (node: ts.Identifier) => boolean): boolean {
  const target = unwrapExpression(expr);
  if (ts.isIdentifier(target)) {
    return ES5_INTRINSIC_OBJECTS.has(target.text) && isAmbientBinding(target);
  }
  if (ts.isPropertyAccessExpression(target) && target.name.text === "prototype" && ts.isIdentifier(target.expression)) {
    return ES5_INTRINSIC_PROTOTYPES.has(target.expression.text) && isAmbientBinding(target.expression);
  }
  return false;
}

/**
 * Recognise the ES5 initial-realm invariant
 * `Object.isFrozen(%IntrinsicObject%) === false`.
 *
 * The result is deliberately source-conservative: shadowed globals and any
 * source that mentions an integrity mutator stay on the runtime-observed path.
 * Both the IR selector/lowerer and the legacy module-init adapter use this
 * single IR-owned decision.
 */
export function isPristineEs5IntrinsicIsFrozenCall(
  expr: ts.CallExpression,
  isAmbientBinding: (node: ts.Identifier) => boolean,
): boolean {
  if (
    expr.arguments.length !== 1 ||
    !ts.isPropertyAccessExpression(expr.expression) ||
    expr.expression.name.text !== "isFrozen" ||
    !ts.isIdentifier(expr.expression.expression) ||
    expr.expression.expression.text !== "Object" ||
    !isAmbientBinding(expr.expression.expression)
  ) {
    return false;
  }

  const arg = expr.arguments[0]!;
  return (
    !ts.isSpreadElement(arg) &&
    isEs5IntrinsicObject(arg, isAmbientBinding) &&
    !sourceMayMutateIntegrity(expr.getSourceFile())
  );
}
