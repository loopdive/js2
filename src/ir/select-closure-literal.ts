// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../ts-api.js";
import type { IrFunctionMemberClosurePlan } from "./function-member-closure-plan.js";

type Literal = ts.ArrowFunction | ts.FunctionExpression | ts.MethodDeclaration;
interface ClosureSelectorHost<Projection> {
  shapeNo(detail: string, node: ts.Node): false;
  annotationToResolvedKind(node: ts.TypeNode): unknown;
  closureLiteralDefaultParamStart(
    parameters: readonly ts.ParameterDeclaration[],
    allow: boolean,
    scope: ReadonlySet<string>,
  ): number | null;
  isPhase1ClosureParameterTypeNode(node: ts.TypeNode, parameter: ts.ParameterDeclaration, expression: Literal): boolean;
  isPhase1BindingPattern(pattern: ts.BindingPattern, scope: ReadonlySet<string>): boolean;
  collectPatternNames(pattern: ts.BindingPattern, scope: Set<string>): void;
  enterProjectionBindingScope(parameters: readonly ts.ParameterDeclaration[]): Projection;
  recordCallableProjection(name: string, arity: { min: number; max: number }, result: ts.TypeNode | undefined): void;
  isExpressionBuildable(expression: ts.Expression, scope: ReadonlySet<string>, classes: ReadonlySet<string>): boolean;
  isStatementListBuildable(
    statements: readonly ts.Statement[],
    scope: Set<string>,
    classes: ReadonlySet<string>,
  ): boolean;
  restoreProjectionBindings(projection: Projection): void;
  withClosureState<T>(plan: IrFunctionMemberClosurePlan | undefined, callback: () => T): T;
}

/** Canonical closure body selection. A source plan is a refusal guard + ABI, never a replacement body. */
export function closureLiteralIsBuildable<Projection>(
  expr: Literal,
  scope: ReadonlySet<string>,
  localClasses: ReadonlySet<string>,
  allowNumericDefaultSuffix: boolean,
  plan: IrFunctionMemberClosurePlan | undefined,
  host: ClosureSelectorHost<Projection>,
): boolean {
  const body = expr.body;
  if (!body) return host.shapeNo("closure-body-missing", expr);
  if ("asteriskToken" in expr && expr.asteriskToken) return host.shapeNo("closure-generator", expr);
  if (expr.modifiers && expr.modifiers.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword))
    return host.shapeNo("closure-async", expr);
  if (expr.typeParameters && expr.typeParameters.length > 0) return host.shapeNo("closure-type-params", expr);
  if (plan && (plan.expression !== expr || !plan.isCurrent())) return host.shapeNo("closure-member-plan-stale", expr);
  if (!plan && (!expr.type || host.annotationToResolvedKind(expr.type) === null))
    return host.shapeNo("closure-return-type", expr.type ?? expr);
  const inner = new Set(plan ? [] : scope);
  // (#7106 Stage 4) A planned closure that reads its own `this` binds it at entry.
  if (plan?.thisStrict !== undefined) inner.add("this");
  if (ts.isFunctionExpression(expr) && expr.name) {
    if (inner.has(expr.name.text)) return host.shapeNo("closure-name-shadow", expr.name);
    inner.add(expr.name.text);
  }
  const defaultParamStart = host.closureLiteralDefaultParamStart(expr.parameters, allowNumericDefaultSuffix, scope);
  if (defaultParamStart === null) return host.shapeNo("closure-param-default", expr);
  for (const p of expr.parameters) {
    if (p.questionToken || p.dotDotDotToken) return host.shapeNo("closure-param-shape", p);
    if (!plan && (!p.type || !host.isPhase1ClosureParameterTypeNode(p.type, p, expr)))
      return host.shapeNo("closure-param-type", p.type ?? p);
    if (ts.isIdentifier(p.name)) {
      if (inner.has(p.name.text)) return host.shapeNo("closure-param-shadow", p.name);
      inner.add(p.name.text);
      continue;
    }
    if (!host.isPhase1BindingPattern(p.name, inner)) return host.shapeNo("closure-param-name", p.name);
    host.collectPatternNames(p.name, inner);
  }
  const projectionBindings = host.enterProjectionBindingScope(expr.parameters);
  if (ts.isFunctionExpression(expr) && expr.name)
    host.recordCallableProjection(expr.name.text, { min: defaultParamStart, max: expr.parameters.length }, expr.type);
  try {
    return host.withClosureState(plan, () => {
      const classes = plan ? new Set<string>() : localClasses;
      if (ts.isArrowFunction(expr) && !ts.isBlock(body))
        return host.isExpressionBuildable(body, inner, classes) || host.shapeNo("closure-concise-body", body);
      if (!ts.isBlock(body)) return host.shapeNo("closure-body-kind", body);
      return host.isStatementListBuildable(body.statements, inner, classes) || host.shapeNo("closure-body", body);
    });
  } finally {
    host.restoreProjectionBindings(projectionBindings);
  }
}

interface ClosureDefaultHost {
  unwrapProjectionExpression(expression: ts.Expression): ts.Expression;
  expressionIsProvenNumber(expression: ts.Expression): boolean;
  collectPatternNames(pattern: ts.BindingPattern, names: Set<string>): void;
}

function closureNumericDefaultInitializerIsIrSafe(
  initializer: ts.Expression,
  availableParamNames: ReadonlySet<string>,
  ownParamNames: ReadonlySet<string>,
  outerScope: ReadonlySet<string>,
  host: ClosureDefaultHost,
): boolean {
  const candidate = host.unwrapProjectionExpression(initializer);
  if (ts.isNumericLiteral(candidate)) return true;
  if (ts.isIdentifier(candidate)) {
    if (availableParamNames.has(candidate.text)) return true;
    return (
      !ownParamNames.has(candidate.text) && outerScope.has(candidate.text) && host.expressionIsProvenNumber(candidate)
    );
  }
  if (
    ts.isPrefixUnaryExpression(candidate) &&
    (candidate.operator === ts.SyntaxKind.PlusToken || candidate.operator === ts.SyntaxKind.MinusToken)
  ) {
    return closureNumericDefaultInitializerIsIrSafe(
      candidate.operand,
      availableParamNames,
      ownParamNames,
      outerScope,
      host,
    );
  }
  return (
    ts.isBinaryExpression(candidate) &&
    (candidate.operatorToken.kind === ts.SyntaxKind.PlusToken ||
      candidate.operatorToken.kind === ts.SyntaxKind.MinusToken ||
      candidate.operatorToken.kind === ts.SyntaxKind.AsteriskToken ||
      candidate.operatorToken.kind === ts.SyntaxKind.SlashToken) &&
    closureNumericDefaultInitializerIsIrSafe(candidate.left, availableParamNames, ownParamNames, outerScope, host) &&
    closureNumericDefaultInitializerIsIrSafe(candidate.right, availableParamNames, ownParamNames, outerScope, host)
  );
}

export function closureLiteralDefaultParamStart(
  parameters: readonly ts.ParameterDeclaration[],
  allowNumericDefaultSuffix: boolean,
  outerScope: ReadonlySet<string>,
  host: ClosureDefaultHost,
): number | null {
  let firstDefault = parameters.length;
  const availableParamNames = new Set<string>();
  const ownParamNames = new Set<string>();
  for (const parameter of parameters) {
    if (ts.isIdentifier(parameter.name)) ownParamNames.add(parameter.name.text);
    else host.collectPatternNames(parameter.name, ownParamNames);
  }
  for (let index = 0; index < parameters.length; index++) {
    const parameter = parameters[index]!;
    if (!parameter.initializer) {
      if (firstDefault !== parameters.length) return null;
    } else if (
      !allowNumericDefaultSuffix ||
      !ts.isIdentifier(parameter.name) ||
      parameter.type?.kind !== ts.SyntaxKind.NumberKeyword ||
      !closureNumericDefaultInitializerIsIrSafe(
        parameter.initializer,
        availableParamNames,
        ownParamNames,
        outerScope,
        host,
      )
    ) {
      return null;
    } else if (firstDefault === parameters.length) {
      firstDefault = index;
    }
    if (ts.isIdentifier(parameter.name) && parameter.type?.kind === ts.SyntaxKind.NumberKeyword) {
      availableParamNames.add(parameter.name.text);
    }
  }
  return firstDefault;
}

export function closureParameterTypeIsBuildable(
  node: ts.TypeNode,
  parameter: ts.ParameterDeclaration,
  owner: Literal,
  annotationToResolvedKind: (node: ts.TypeNode) => unknown,
  functionTypeIsBuildable: (node: ts.FunctionTypeNode) => boolean,
  closureParameterHasExactImmediateInternalSource: (parameter: ts.ParameterDeclaration, owner: Literal) => boolean,
): boolean {
  if (ts.isFunctionTypeNode(node)) {
    return functionTypeIsBuildable(node) && closureParameterHasExactImmediateInternalSource(parameter, owner);
  }
  const primitive = annotationToResolvedKind(node);
  if (primitive === "f64" || primitive === "bool" || primitive === "string") return true;
  if (ts.isArrayTypeNode(node)) return node.elementType.kind === ts.SyntaxKind.NumberKeyword;
  if (!ts.isTypeLiteralNode(node) || node.members.length === 0) return false;
  const names = new Set<string>();
  for (const member of node.members) {
    if (
      !ts.isPropertySignature(member) ||
      member.questionToken ||
      !member.type ||
      (member.type.kind !== ts.SyntaxKind.NumberKeyword &&
        member.type.kind !== ts.SyntaxKind.BooleanKeyword &&
        member.type.kind !== ts.SyntaxKind.StringKeyword)
    ) {
      return false;
    }
    const name = ts.isIdentifier(member.name)
      ? member.name.text
      : ts.isStringLiteral(member.name) || ts.isNumericLiteral(member.name)
        ? member.name.text
        : null;
    if (name === null || names.has(name)) return false;
    names.add(name);
  }
  return true;
}
