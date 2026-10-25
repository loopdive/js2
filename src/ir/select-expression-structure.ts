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
    !(ts.isBinaryExpression(use) && use.left === access && use.operatorToken.kind === ts.SyntaxKind.EqualsToken) &&
    !isFunctionObjectChainedWrite(access)
  )
    return;
  return resolver?.resolveTopLevelFunctionValue(node);
}

/**
 * (#7106 census arm 3) `F.p.x = v` — the function object's `F.p` member READ is
 * the receiver of a member WRITE (`Test262Error.prototype.toString = …`). `F`
 * is still only a dynamic receiver: `F.p` is a dynamic member get on the boxed
 * function object, and the write a dynamic member set on its result.
 */
export function isFunctionObjectChainedWrite(
  access: ts.PropertyAccessExpression | ts.ElementAccessExpression,
): boolean {
  const store = access.parent;
  return (
    ts.isPropertyAccessExpression(access) &&
    ts.isPropertyAccessExpression(store) &&
    ts.isIdentifier(store.name) &&
    store.expression === access &&
    store.questionDotToken === undefined &&
    ts.isBinaryExpression(store.parent) &&
    store.parent.left === store &&
    store.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
  );
}

/**
 * A stable top-level function used ONLY as the receiver of a member call or
 * member write. (#7108-successor arm, #7106 census arm 4) No signature
 * evidence is required: such a use lowers to the canonical function object
 * boxed into the dynamic carrier (`objectReceiver` plan), and the planner
 * mints that plan with an opaque signature when the target is unannotated —
 * the signature only types the accessor's externref result before the box.
 */
export function isFunctionObjectReceiver(
  node: ts.Identifier,
  resolver: IrImportedFunctionResolver | undefined,
): boolean {
  return resolveFunctionObjectReceiver(node, resolver) !== undefined;
}

/**
 * (#7106 census arm 3) `F.x = G` / `F[k] = G`: a stable top-level function `G`
 * stored on a function-object receiver `F`. The value is boxed into the dynamic
 * carrier and written through the receiver's dynamic member write — like a
 * receiver-only use it never reads `G`'s signature, so it needs no evidence.
 */
export function isFunctionObjectStoredValue(
  node: ts.Identifier,
  resolver: IrImportedFunctionResolver | undefined,
): boolean {
  const root = functionObjectStoreRoot(node);
  return (
    root !== undefined &&
    resolveFunctionObjectReceiver(root, resolver) !== undefined &&
    resolver?.resolveTopLevelFunctionValue(node) !== undefined
  );
}

/**
 * The receiver identifier `F` when `node` is the stored value of `F.x = node`,
 * `F[k] = node` or the chained `F.p.x = node` (see
 * {@link isFunctionObjectChainedWrite}); otherwise `undefined`. Syntax only —
 * the selector and the planner each apply their own resolver to `F` and `node`.
 */
export function functionObjectStoreRoot(node: ts.Identifier): ts.Identifier | undefined {
  const assignment = node.parent;
  if (
    !ts.isBinaryExpression(assignment) ||
    assignment.right !== node ||
    assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken
  )
    return undefined;
  const store = assignment.left;
  if (!(ts.isPropertyAccessExpression(store) || ts.isElementAccessExpression(store)) || store.questionDotToken)
    return undefined;
  if (ts.isIdentifier(store.expression)) return store.expression;
  const chained = store.expression;
  return ts.isPropertyAccessExpression(chained) &&
    ts.isIdentifier(chained.expression) &&
    chained.questionDotToken === undefined &&
    isFunctionObjectChainedWrite(chained)
    ? chained.expression
    : undefined;
}

export function functionObjectMemberCallIsBuildable(
  expr: ts.CallExpression,
  resolver: IrImportedFunctionResolver | undefined,
  isExpressionBuildable: (expression: ts.Expression) => boolean,
): boolean | undefined {
  const functionAccess = expr.expression;
  const target =
    (ts.isPropertyAccessExpression(functionAccess) || ts.isElementAccessExpression(functionAccess)) &&
    ts.isIdentifier(functionAccess.expression)
      ? resolveFunctionObjectReceiver(functionAccess.expression, resolver)
      : undefined;
  if (target && (ts.isPropertyAccessExpression(functionAccess) || ts.isElementAccessExpression(functionAccess))) {
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

/**
 * (#7129) The primitive kind of the ONE literal every value `return` of
 * `body` yields (`return 42`, `return -1`, `return 'A'`, the same literal on
 * several paths), else `null`. The checker widens a single return literal to
 * `number` / `string` for an unannotated signature, so the kind equals the
 * legacy-registered slot. Two distinct literals (`return 1` and `return 2`)
 * infer the union `1 | 2`, which legacy's class descriptor does not register,
 * so they answer `null` here. A bare `return;` or any other expression (a
 * call, an identifier, a template with substitutions) answers `null`. Boolean
 * literals are deliberately excluded: the class-method slot legacy registers
 * for an inferred `boolean` does not match the IR's bool signature (typeIdx
 * parity mismatch, measured 2026-10-22), so such a method stays legacy.
 * Returns inside nested functions and classes belong to those, not to `body`.
 */
export function uniformLiteralReturnKind(body: ts.Block): "f64" | "string" | null {
  let kind: "f64" | "string" | null = null;
  let value: number | string | undefined;
  let ok = true;
  const literal = (expr: ts.Expression): { kind: "f64" | "string"; value: number | string } | null => {
    while (ts.isParenthesizedExpression(expr)) expr = expr.expression;
    if (ts.isPrefixUnaryExpression(expr)) {
      if (!ts.isNumericLiteral(expr.operand)) return null;
      if (expr.operator === ts.SyntaxKind.MinusToken) return { kind: "f64", value: -Number(expr.operand.text) };
      return expr.operator === ts.SyntaxKind.PlusToken ? { kind: "f64", value: Number(expr.operand.text) } : null;
    }
    if (ts.isNumericLiteral(expr)) return { kind: "f64", value: Number(expr.text) };
    if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr))
      return { kind: "string", value: expr.text };
    return null;
  };
  const visit = (node: ts.Node): void => {
    if (!ok) return;
    if (ts.isReturnStatement(node)) {
      const next = node.expression ? literal(node.expression) : null;
      if (next === null || (kind !== null && (kind !== next.kind || value !== next.value))) ok = false;
      else ({ kind, value } = next);
      return;
    }
    if (ts.isFunctionLike(node) || ts.isClassLike(node)) return;
    forEachChild(node, visit);
  };
  forEachChild(body, visit);
  return ok ? kind : null;
}
