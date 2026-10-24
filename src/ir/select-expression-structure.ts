// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { forEachChild, ts } from "../ts-api.js";
import type { IrImportedFunctionResolver, IrResolvedFunctionTarget } from "./imported-functions.js";

export function unwrapTypeErasedExpression(expr: ts.Expression): ts.Expression | undefined {
  return ts.isAsExpression(expr) ||
    ts.isTypeAssertionExpression(expr) ||
    ts.isSatisfiesExpression(expr) ||
    ts.isNonNullExpression(expr)
    ? expr.expression
    : undefined;
}

/** Reject affine three-deep indices whose IR widening is costlier than legacy i32 induction. */
export function isAffineThreeDeepElementAccess(expr: ts.ElementAccessExpression): boolean {
  let enclosingForDepth = 0;
  for (let parent: ts.Node | undefined = expr.parent; parent; parent = parent.parent) {
    if (ts.isForStatement(parent)) enclosingForDepth++;
    if (ts.isFunctionLike(parent)) break;
  }
  if (enclosingForDepth < 3) return false;
  let indexHasMultiply = false;
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AsteriskToken) {
      indexHasMultiply = true;
      return;
    }
    forEachChild(node, visit);
  };
  visit(expr.argumentExpression);
  return indexHasMultiply;
}

/**
 * Return the declaration's effective parameter type node.
 *
 * For TypeScript this is the ordinary `param.type`. For JavaScript, the TS
 * parser/checker boundary exposes a standard `@param {T}` annotation through
 * `getJSDocType` while deliberately leaving `param.type` unset. Keeping this
 * lookup in one helper prevents the selector and the shared AST-to-IR
 * signature resolver from disagreeing about the same source declaration. No
 * comment text is parsed and no synthetic annotation is attached to the AST.
 */
export function effectiveIrParamTypeNode(param: ts.ParameterDeclaration): ts.TypeNode | undefined {
  if (param.type) return param.type;
  // A synthesized parameter (factory-built, no parent — the implicit-ctor
  // pipeline in from-ast) carries no JSDoc; `getJSDocType` walks `parent`
  // and would throw. Its type comes from `paramTypeOverrides`.
  if (param.parent === undefined) return undefined;
  return ts.getJSDocType(param);
}

/**
 * Return the declaration's effective return type node, including a JavaScript
 * JSDoc `@returns {T}` annotation when present.
 *
 * The caller still applies the existing narrow primitive/object/dynamic
 * mapping. In particular, this helper does not turn an unannotated, `any`,
 * union, or otherwise unsupported signature into a primitive claim.
 */
export function effectiveIrReturnTypeNode(
  fn: ts.FunctionDeclaration | ts.MethodDeclaration | ts.GetAccessorDeclaration | ts.SetAccessorDeclaration,
): ts.TypeNode | undefined {
  return fn.type ?? ts.getJSDocReturnType(fn);
}

export interface FunctionObjectTypeEvidence {
  readonly parameterType: (parameter: ts.ParameterDeclaration) => ts.TypeNode | undefined;
  readonly returnType: (declaration: ts.FunctionDeclaration) => ts.TypeNode | undefined;
}

/** Preclaim evidence cannot depend on a target acquiring a later IR claim. */
export function functionObjectHasTypeEvidence(
  declaration: ts.FunctionDeclaration,
  evidence: FunctionObjectTypeEvidence,
): boolean {
  return (
    declaration.parameters.every((parameter) => evidence.parameterType(parameter) !== undefined) &&
    evidence.returnType(declaration) !== undefined
  );
}

function resolveFunctionObjectReceiver(
  node: ts.Identifier,
  resolver: IrImportedFunctionResolver | undefined,
): IrResolvedFunctionTarget | undefined {
  const access = node.parent;
  if (
    !(ts.isPropertyAccessExpression(access) || ts.isElementAccessExpression(access)) ||
    access.expression !== node ||
    access.questionDotToken !== undefined
  )
    return;
  const use = access.parent;
  if (
    !(ts.isCallExpression(use) && use.expression === access) &&
    !(ts.isBinaryExpression(use) && use.left === access && use.operatorToken.kind === ts.SyntaxKind.EqualsToken)
  )
    return;
  return resolver?.resolveTopLevelFunctionValue(node);
}

/** Without evidence this is only the existing stable receiver-identity test. */
export function isFunctionObjectReceiver(
  node: ts.Identifier,
  resolver: IrImportedFunctionResolver | undefined,
  evidence?: FunctionObjectTypeEvidence,
): boolean {
  const target = resolveFunctionObjectReceiver(node, resolver);
  return (
    target !== undefined && (evidence === undefined || functionObjectHasTypeEvidence(target.declaration, evidence))
  );
}

export function functionObjectMemberCallIsBuildable(
  expr: ts.CallExpression,
  resolver: IrImportedFunctionResolver | undefined,
  evidence: FunctionObjectTypeEvidence,
  isExpressionBuildable: (expression: ts.Expression) => boolean,
): boolean | undefined {
  const functionAccess = expr.expression;
  const target =
    (ts.isPropertyAccessExpression(functionAccess) || ts.isElementAccessExpression(functionAccess)) &&
    ts.isIdentifier(functionAccess.expression)
      ? resolveFunctionObjectReceiver(functionAccess.expression, resolver)
      : undefined;
  if (target && (ts.isPropertyAccessExpression(functionAccess) || ts.isElementAccessExpression(functionAccess))) {
    if (!functionObjectHasTypeEvidence(target.declaration, evidence)) return false;
    if (functionAccess.questionDotToken || expr.questionDotToken || expr.arguments.some(ts.isSpreadElement))
      return false;
    if (ts.isElementAccessExpression(functionAccess) && !isExpressionBuildable(functionAccess.argumentExpression))
      return false;
    return expr.arguments.every((argument) => isExpressionBuildable(argument));
  }
  return undefined;
}

export function identifierIsValueReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return true;
  if (
    (ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isBindingElement(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isClassExpression(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isMethodSignature(parent)) &&
    parent.name === node
  ) {
    return false;
  }
  if (
    (ts.isPropertyAccessExpression(parent) ||
      ts.isPropertyAssignment(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent)) &&
    parent.name === node
  ) {
    return false;
  }
  if (ts.isLabeledStatement(parent) && parent.label === node) return false;
  if ((ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) && parent.label === node) return false;
  return true;
}

export function expressionIsDefinitelyBoolean(expression: ts.Expression): boolean {
  let candidate = expression;
  while (ts.isParenthesizedExpression(candidate)) candidate = candidate.expression;
  if (candidate.kind === ts.SyntaxKind.TrueKeyword || candidate.kind === ts.SyntaxKind.FalseKeyword) return true;
  if (ts.isPrefixUnaryExpression(candidate) && candidate.operator === ts.SyntaxKind.ExclamationToken) return true;
  if (ts.isBinaryExpression(candidate)) {
    const op = candidate.operatorToken.kind;
    return (
      op === ts.SyntaxKind.LessThanToken ||
      op === ts.SyntaxKind.LessThanEqualsToken ||
      op === ts.SyntaxKind.GreaterThanToken ||
      op === ts.SyntaxKind.GreaterThanEqualsToken ||
      op === ts.SyntaxKind.EqualsEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsToken ||
      op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
      op === ts.SyntaxKind.InstanceOfKeyword ||
      op === ts.SyntaxKind.InKeyword ||
      op === ts.SyntaxKind.AmpersandAmpersandToken ||
      op === ts.SyntaxKind.BarBarToken
    );
  }
  if (ts.isConditionalExpression(candidate)) {
    return expressionIsDefinitelyBoolean(candidate.whenTrue) && expressionIsDefinitelyBoolean(candidate.whenFalse);
  }
  return false;
}

/** Whole parent-method source/arity/argument verdict, with caller-owned facts. */
export function superMethodCallIsBuildable(
  expr: ts.CallExpression,
  host: {
    readonly superParentClassName: () => string | null;
    readonly localClassHasKnownProjectionGap: (name: string) => boolean;
    readonly classMethodProjection: (
      name: string,
      member: string,
      isStatic: boolean,
    ) => {
      readonly status: string;
      readonly arity?: number;
    };
    readonly shapeNo: (arm: string, node: ts.Node) => false;
    readonly capabilityNo: (
      reason: "class-projection-unsupported" | "class-member-unsupported" | "call-arity-unsupported",
      arm: string,
      node: ts.Node,
    ) => false;
    readonly isExpressionBuildable: (argument: ts.Expression) => boolean;
  },
): boolean | undefined {
  const {
    superParentClassName,
    localClassHasKnownProjectionGap,
    classMethodProjection,
    shapeNo,
    capabilityNo,
    isExpressionBuildable,
  } = host;
  if (
    ts.isPropertyAccessExpression(expr.expression) &&
    expr.expression.expression.kind === ts.SyntaxKind.SuperKeyword
  ) {
    if (!ts.isIdentifier(expr.expression.name)) return shapeNo("super-method-computed", expr);
    const parentClass = superParentClassName();
    if (parentClass === null || localClassHasKnownProjectionGap(parentClass)) {
      return capabilityNo("class-projection-unsupported", "super-method-parent-shape", expr);
    }
    const projection = classMethodProjection(parentClass, expr.expression.name.text, false);
    if (projection.status !== "projected" || projection.arity === undefined) {
      return capabilityNo("class-member-unsupported", "super-method-member", expr);
    }
    if (expr.arguments.length !== projection.arity) {
      return capabilityNo("call-arity-unsupported", "super-method-arity", expr);
    }
    for (const arg of expr.arguments) {
      if (ts.isSpreadElement(arg)) return shapeNo("super-method-spread", arg);
      if (!isExpressionBuildable(arg)) return false;
    }
    return true;
  }
  return undefined;
}

export function unwrapParenthesizedExpression(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

/** A native dynamic operand can pair with a proven primitive value carrier. */
export function nativeInstanceofValueOperands(
  expression: ts.BinaryExpression,
  evidence: {
    readonly dynamic: (expression: ts.Expression) => boolean;
    readonly primitive: (expression: ts.Expression) => "number" | "boolean" | "string" | undefined;
  },
): boolean {
  const leftDynamic = evidence.dynamic(expression.left);
  const rightDynamic = evidence.dynamic(expression.right);
  const concrete = (expression: ts.Expression): boolean =>
    unwrapParenthesizedExpression(expression).kind === ts.SyntaxKind.NullKeyword ||
    evidence.primitive(expression) !== undefined;
  return (
    (leftDynamic || rightDynamic) &&
    (leftDynamic || concrete(expression.left)) &&
    (rightDynamic || concrete(expression.right))
  );
}
