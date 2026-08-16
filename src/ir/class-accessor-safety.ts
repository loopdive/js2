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

/**
 * (#3522) Exact instance field initializers a bounded nested ordinary class may
 * carry.
 *
 * The initializer runs inside the class's own constructor `_init`, not in the
 * containing frame, so ClassDefinitionEvaluation stays inert and the ordered
 * source-owned field plan established by the 2026-08-12 initialized
 * instance-field checkpoint owns it unchanged.
 *
 * What is rejected here is CALL EDGES, not expression complexity. A nested
 * class's field-initializer support unit is attributed to the containing
 * executable, while the constructor terminal that ultimately runs the
 * initializer is attributed to the class. A call inside the initializer is
 * therefore planned twice with two different owner units, which the integration
 * call planner correctly refuses (`selection-preparation-mismatch`,
 * "direct-call plan … disagrees with exact integration identity") — measured on
 * `class Box { p: number = seed(); … }` inside a function, a hard compile
 * failure rather than a demotion. Owning that attribution is a later slice; the
 * predicate fails closed on every callable form until then, so no admitted
 * shape can reach it. Nested executables and `super` are rejected for the same
 * reason they are in an accessor body: they would move ownership out of the
 * class.
 */
function boundedPreparedInstanceFieldInitializer(initializer: ts.Expression): boolean {
  let bounded = true;
  const visit = (node: ts.Node): void => {
    if (!bounded) return;
    if (
      ts.isCallExpression(node) ||
      ts.isNewExpression(node) ||
      ts.isTaggedTemplateExpression(node) ||
      ts.isFunctionLike(node) ||
      ts.isClassDeclaration(node) ||
      ts.isClassExpression(node) ||
      node.kind === ts.SyntaxKind.SuperKeyword
    ) {
      bounded = false;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(initializer);
  return bounded;
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
 * decorators, computed keys, or static work can execute in the containing
 * frame. Body capture/type safety remains the structural selector's
 * responsibility, and the identity selector admits the class only when every
 * body-bearing member claims atomically.
 *
 * #3522 — the constructor may be IMPLICIT. An absent constructor on a class
 * with no heritage and no initialized fields has exactly the same inert
 * definition evaluation as an explicit empty one, and the synthesized
 * `_new`/`_init` support pair is already the sole allocation implementation
 * for that shape at top level (2026-08-12 plain implicit-constructor
 * checkpoint). Admitting zero here does NOT admit an implicit DERIVED
 * constructor: `heritageClauses` is rejected above, so no forwarding chain and
 * no shadow-identity inheritance surface is reachable from this predicate.
 *
 * #3522 — instance GET/SET ACCESSORS are ordinary members of this family.
 * An accessor's definition evaluation is exactly a method's: a body-bearing
 * callable installed on the prototype, with no initializer running in the
 * containing frame. The lowering, the callable ABI, and the accessor
 * descriptor plumbing already exist and are proven at top level (a top-level
 * class with a getter, or with a getter/setter pair reading `this`, compiles
 * once today). Only the member-shape gate here was method-only, which
 * withdrew the entire enclosing owner for any nested class carrying one.
 *
 * Accessor shape is restricted exactly as methods are — non-static (rejected
 * above for every member), undecorated, identifier-named, body-bearing, and
 * fixed-arity (getter zero parameters, setter exactly one plain parameter).
 * Semantic-key collisions, static/instance placement collisions, and
 * descriptor mismatches are NOT this predicate's contract: the identity
 * selector re-derives each accessor's exact descriptor and withdraws the whole
 * bounded class when any of them is ambiguous.
 *
 * #3522 — INITIALIZED instance fields are ordinary members of this family, so
 * long as their initializer carries no call edge
 * (`boundedPreparedInstanceFieldInitializer`). The initializer executes in the
 * class's own constructor `_init`, in source order, under the plan the
 * 2026-08-12 initialized instance-field checkpoint already owns at top level;
 * nothing about it runs in the containing frame. STATIC fields are a different
 * contract and stay rejected above: their initializer runs at class-definition
 * time IN the containing frame, which is exactly the inertness this predicate
 * asserts.
 */
export function isBoundedPreparedNestedOrdinaryClass(declaration: ts.ClassDeclaration | ts.ClassExpression): boolean {
  if (declaration.heritageClauses?.length || hasDecorators(declaration) || declaration.members.length === 0) {
    return false;
  }
  let constructorCount = 0;
  let callableMemberCount = 0;
  for (const member of declaration.members) {
    if (hasDecorators(member)) return false;
    const isStatic = hasModifier(member, ts.SyntaxKind.StaticKeyword);
    if (ts.isPropertyDeclaration(member)) {
      if (isStatic) return false;
      if (!ts.isIdentifier(member.name) && !ts.isPrivateIdentifier(member.name)) {
        return false;
      }
      if (member.initializer !== undefined && !boundedPreparedInstanceFieldInitializer(member.initializer)) {
        return false;
      }
      continue;
    }
    if (isStatic) return false;
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
      callableMemberCount++;
      continue;
    }
    if (ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) {
      if (
        !member.body ||
        !ts.isIdentifier(member.name) ||
        hasModifier(member, ts.SyntaxKind.AbstractKeyword) ||
        !hasFixedPreparedParameters(member.parameters) ||
        member.parameters.length !== (ts.isGetAccessorDeclaration(member) ? 0 : 1)
      ) {
        return false;
      }
      callableMemberCount++;
      continue;
    }
    return false;
  }
  return constructorCount <= 1 && callableMemberCount > 0;
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
