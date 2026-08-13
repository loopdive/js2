// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../ts-api.js";

function hasDecorators(node: ts.Node): boolean {
  return ts.canHaveDecorators(node) && (ts.getDecorators(node)?.length ?? 0) > 0;
}

function boundedPreparedAccessorBody(body: ts.Block): boolean {
  let bounded = true;
  const visit = (node: ts.Node): void => {
    if (!bounded) return;
    if (
      node.kind === ts.SyntaxKind.ThisKeyword ||
      node.kind === ts.SyntaxKind.SuperKeyword ||
      ts.isFunctionLike(node) ||
      ts.isClassDeclaration(node) ||
      ts.isClassExpression(node)
    ) {
      bounded = false;
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(body, visit);
  return bounded;
}

/** Exact accessor-only class family that may be prepared atomically. */
export function isBoundedPreparedAccessorClass(declaration: ts.ClassDeclaration | ts.ClassExpression): boolean {
  if (declaration.heritageClauses?.length || hasDecorators(declaration) || declaration.members.length === 0) {
    return false;
  }
  return declaration.members.every((member) => {
    if (
      (!ts.isGetAccessorDeclaration(member) && !ts.isSetAccessorDeclaration(member)) ||
      !member.body ||
      ts.isPrivateIdentifier(member.name) ||
      hasDecorators(member)
    ) {
      return false;
    }
    if (ts.isGetAccessorDeclaration(member)) {
      return member.parameters.length === 0 && boundedPreparedAccessorBody(member.body);
    }
    const parameter = member.parameters[0];
    return (
      member.parameters.length === 1 &&
      parameter !== undefined &&
      ts.isIdentifier(parameter.name) &&
      parameter.type === undefined &&
      parameter.initializer === undefined &&
      parameter.dotDotDotToken === undefined &&
      !hasDecorators(parameter) &&
      boundedPreparedAccessorBody(member.body)
    );
  });
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) ?? false);
}

function hasFixedPreparedParameters(parameters: readonly ts.ParameterDeclaration[]): boolean {
  return parameters.every(
    (parameter) =>
      ts.isIdentifier(parameter.name) &&
      parameter.dotDotDotToken === undefined &&
      parameter.questionToken === undefined &&
      parameter.initializer === undefined &&
      !hasDecorators(parameter),
  );
}

/**
 * Exact flat ordinary class family whose constructor and instance methods may
 * be prepared independently of a still-direct containing executable.
 *
 * The restriction makes ClassDefinitionEvaluation inert: no heritage,
 * decorators, computed keys, static work, or field initializers can execute in
 * the containing frame. Body capture/type safety remains the structural
 * selector's responsibility, and the identity selector admits the class only
 * when every body-bearing member claims atomically.
 */
export function isBoundedPreparedNestedOrdinaryClass(declaration: ts.ClassDeclaration | ts.ClassExpression): boolean {
  if (declaration.heritageClauses?.length || hasDecorators(declaration) || declaration.members.length === 0) {
    return false;
  }
  let constructorCount = 0;
  let methodCount = 0;
  for (const member of declaration.members) {
    if (hasDecorators(member) || hasModifier(member, ts.SyntaxKind.StaticKeyword)) return false;
    if (ts.isPropertyDeclaration(member)) {
      if (member.initializer !== undefined || (!ts.isIdentifier(member.name) && !ts.isPrivateIdentifier(member.name))) {
        return false;
      }
      continue;
    }
    if (ts.isConstructorDeclaration(member)) {
      if (!member.body) continue; // Type-only overload signature.
      constructorCount++;
      if (constructorCount !== 1 || !hasFixedPreparedParameters(member.parameters)) return false;
      continue;
    }
    if (ts.isMethodDeclaration(member)) {
      if (
        !member.body ||
        !ts.isIdentifier(member.name) ||
        member.asteriskToken !== undefined ||
        hasModifier(member, ts.SyntaxKind.AsyncKeyword) ||
        hasModifier(member, ts.SyntaxKind.AbstractKeyword) ||
        !hasFixedPreparedParameters(member.parameters)
      ) {
        return false;
      }
      methodCount++;
      continue;
    }
    return false;
  }
  return constructorCount === 1 && methodCount > 0;
}

/**
 * Stable lexical name for the bounded ordinary-class transaction.
 *
 * Class declarations own their source name. Class expressions are admitted
 * only in the exact `const C = class { ... }` / `const C = class C { ... }`
 * form: the binding is immutable, ClassDefinitionEvaluation is inert under
 * the ordinary-class gate above, and a differently named inner class cannot
 * be confused with the outer constructor binding.
 */
export function boundedPreparedNestedOrdinaryClassBindingName(
  declaration: ts.ClassDeclaration | ts.ClassExpression,
): string | undefined {
  if (!isBoundedPreparedNestedOrdinaryClass(declaration)) return undefined;
  if (ts.isClassDeclaration(declaration)) return declaration.name?.text;
  const variable = declaration.parent;
  if (
    !ts.isVariableDeclaration(variable) ||
    variable.initializer !== declaration ||
    !ts.isIdentifier(variable.name) ||
    !ts.isVariableDeclarationList(variable.parent) ||
    (variable.parent.flags & ts.NodeFlags.Const) === 0
  ) {
    return undefined;
  }
  const bindingName = variable.name.text;
  return declaration.name === undefined || declaration.name.text === bindingName ? bindingName : undefined;
}

type LiteralComputedKeyValue = string | number;

function literalOnlyComputedKeyValue(expression: ts.Expression): LiteralComputedKeyValue | undefined {
  let candidate = expression;
  while (
    ts.isParenthesizedExpression(candidate) ||
    ts.isAsExpression(candidate) ||
    ts.isTypeAssertionExpression(candidate) ||
    ts.isSatisfiesExpression(candidate) ||
    ts.isNonNullExpression(candidate)
  ) {
    candidate = candidate.expression;
  }
  if (ts.isStringLiteral(candidate) || ts.isNoSubstitutionTemplateLiteral(candidate)) return candidate.text;
  if (ts.isNumericLiteral(candidate)) return Number(candidate.text);
  if (ts.isPrefixUnaryExpression(candidate)) {
    const operand = literalOnlyComputedKeyValue(candidate.operand);
    if (typeof operand !== "number") return undefined;
    if (candidate.operator === ts.SyntaxKind.PlusToken) return operand;
    if (candidate.operator === ts.SyntaxKind.MinusToken) return -operand;
    return undefined;
  }
  if (ts.isTemplateExpression(candidate)) {
    let value = candidate.head.text;
    for (const span of candidate.templateSpans) {
      const substitution = literalOnlyComputedKeyValue(span.expression);
      if (substitution === undefined) return undefined;
      value += String(substitution) + span.literal.text;
    }
    return value;
  }
  if (!ts.isBinaryExpression(candidate)) return undefined;
  const left = literalOnlyComputedKeyValue(candidate.left);
  const right = literalOnlyComputedKeyValue(candidate.right);
  if (left === undefined || right === undefined) return undefined;
  if (candidate.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return typeof left === "string" || typeof right === "string" ? String(left) + String(right) : left + right;
  }
  if (typeof left !== "number" || typeof right !== "number") return undefined;
  switch (candidate.operatorToken.kind) {
    case ts.SyntaxKind.MinusToken:
      return left - right;
    case ts.SyntaxKind.AsteriskToken:
      return left * right;
    case ts.SyntaxKind.SlashToken:
      return right === 0 ? undefined : left / right;
    case ts.SyntaxKind.PercentToken:
      return right === 0 ? undefined : left % right;
    case ts.SyntaxKind.AsteriskAsteriskToken:
      return left ** right;
    default:
      return undefined;
  }
}

/** Resolve a call-site key expression without evaluating or following bindings. */
export function exactPreparedAccessorExpressionKey(expression: ts.Expression): string | undefined {
  const value = literalOnlyComputedKeyValue(expression);
  return value === undefined ? undefined : String(value);
}

/** Resolve only literal/pure-literal computed names with exact JS stringification. */
export function exactPreparedAccessorSyntaxKey(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  if (ts.isNumericLiteral(name)) return String(Number(name.text));
  if (!ts.isComputedPropertyName(name)) return undefined;
  let expression = name.expression;
  while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
  return ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isIdentifier(expression.left)
    ? exactPreparedAccessorExpressionKey(expression.right)
    : exactPreparedAccessorExpressionKey(expression);
}
