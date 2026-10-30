// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { NATIVE_REALM_CATALOG } from "../runtime/contracts/native-realm-catalog.js";
import { forEachChild, ts } from "../ts-api.js";
import { isStaticArrayIndex, staticElementKey } from "../shared/array-index-key.js";
import { skipTransparentExpressions } from "../shared/transparent-expressions.js";
import { literalFieldName } from "./fnctor-field-writes.js";
import type { IrImportedFunctionResolver, IrResolvedFunctionTarget } from "./imported-functions.js";
import type { IrSelectionOptions } from "./select.js";

/**
 * (#7106) An Array element key the vec lane leaves to legacy because it names
 * a property, not an element: a static value that is not an array index
 * (`staticElementKey`: `a[0.5]`, `a[-1]`, `a[null]`, `a[true]`,
 * `const k = 0.5`), or any boolean. ToPropertyKey makes it a NAMED property,
 * which only legacy's named-key route reads and writes (#4247, #4556). The
 * static value includes the key's number literal TYPE, which only a refusal
 * may rest on (`staticElementKey`).
 *
 * A static array index of any size stays on the vec lane, reads and writes
 * alike. Past the i32 range the lowering saturates it, so a write traps in the
 * grow-store exactly as before. Legacy's high-index route is no better: it
 * gets a bare literal's plain-store `length` right, but not the element's
 * read-back or a compound (follow-up 3).
 */
export function isLegacyOnlyVecKey(
  key: ts.Expression,
  isShadowed: (id: ts.Identifier) => boolean,
  options: Pick<IrSelectionOptions, "classifyDeclaredPrimitiveExpression" | "numberLiteralTypeValue">,
): boolean {
  const inner = skipTransparentExpressions(key);
  const known = staticElementKey(inner, isShadowed, options.numberLiteralTypeValue);
  if (known !== undefined) return !isStaticArrayIndex(known);
  return options.classifyDeclaredPrimitiveExpression?.(inner) === "boolean";
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
  return isFunctionObjectReceiverUse(node, { chainedWrite: true })
    ? resolver?.resolveTopLevelFunctionValue(node)
    : undefined;
}

/**
 * (#7106) Is `node` used only as the receiver of a function object's member:
 * a member call `F.x(…)`, a member write `F.x = v`, a member read
 * `var v = F.x` (`isFunctionObjectMemberRead`) or, with `chainedWrite`, a
 * chained write `F.p.x = v`? Each lowers to the boxed function object followed
 * by a dynamic member operation, so the member must be one of the object's own
 * expandos ({@link namesFunctionObjectExpando}). An optional access or call is
 * never one. The selector, the planner and the prepared revalidation all ask
 * this one question; the revalidation does not admit chained writes.
 */
export function isFunctionObjectReceiverUse(node: ts.Identifier, opts: { readonly chainedWrite: boolean }): boolean {
  const access = node.parent;
  if (
    !(ts.isPropertyAccessExpression(access) || ts.isElementAccessExpression(access)) ||
    access.expression !== node ||
    access.questionDotToken !== undefined ||
    !namesFunctionObjectExpando(access)
  )
    return false;
  const use = access.parent;
  return (
    (ts.isCallExpression(use) && use.expression === access && !use.questionDotToken) ||
    (ts.isBinaryExpression(use) && use.left === access && use.operatorToken.kind === ts.SyntaxKind.EqualsToken) ||
    (opts.chainedWrite && isFunctionObjectChainedWrite(access)) ||
    (ts.isPropertyAccessExpression(access) && isFunctionObjectMemberRead(access))
  );
}

/**
 * The string keys the realm defines along an ordinary function's prototype
 * chain: %Function.prototype%'s (`bind`, `call`, the %ThrowTypeError%
 * `caller`/`arguments` accessors, and `length`/`name`, which every function
 * also owns as non-writable built-ins) and %Object.prototype%'s (`valueOf`,
 * `hasOwnProperty`, …).
 */
const FUNCTION_REALM_MEMBER_NAMES: ReadonlySet<string> = new Set(
  NATIVE_REALM_CATALOG.intrinsics
    .filter(({ id }) => id === "%Function.prototype%" || id === "%Object.prototype%")
    .flatMap(({ properties }) => properties.flatMap(({ key }) => (key.kind === "string" ? [key.value] : []))),
);

/**
 * (#7106) Does `access` name an own expando of the function object: a literal
 * name the realm does not define for a function? The boxed function object's
 * dynamic member operations do not resolve a realm member (measured on
 * standalone): `F.bind()` and `F.valueOf()` throw "not callable",
 * `var v = F.valueOf` reads undefined, and a strict function's `F.caller = v`
 * stores where the %ThrowTypeError% setter must throw. Legacy owns those
 * members. A dynamic key may name any of them.
 */
function namesFunctionObjectExpando(access: ts.PropertyAccessExpression | ts.ElementAccessExpression): boolean {
  const name = literalFieldName(access);
  return name !== undefined && !FUNCTION_REALM_MEMBER_NAMES.has(name);
}

/**
 * (#7106 Stage 4) `var format = compareArray.format;` — a function object's
 * member READ as the whole initializer of a `var`. Like a member call or write
 * it is a receiver-only use: the boxed function object, then a dynamic member
 * get. Only the declaration-initializer position: an update/delete operand or
 * a destructuring target is not a plain read.
 */
export function isFunctionObjectMemberRead(access: ts.PropertyAccessExpression): boolean {
  const declaration = access.parent;
  return (
    ts.isIdentifier(access.name) &&
    ts.isVariableDeclaration(declaration) &&
    declaration.initializer === access &&
    ts.isIdentifier(declaration.name) &&
    ts.isVariableDeclarationList(declaration.parent) &&
    (declaration.parent.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) === 0
  );
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
 * (#7106 Stage 4) The `var` locals of `fn`'s own body initialized by a
 * function-object member read (`var format = compareArray.format;`) and never
 * written again — no second declaration, assignment or update (a nested
 * function, which could capture one, is refused by every member-closure plan).
 * Each holds the dynamic carrier for its whole life.
 */
export function functionObjectReadLocals(
  fn: ts.FunctionExpression,
  resolver: IrImportedFunctionResolver | undefined,
): ReadonlySet<string> {
  const candidates = new Map<string, number>();
  const written = new Set<string>();
  const parameters = new Set(fn.parameters.flatMap((p) => (ts.isIdentifier(p.name) ? [p.name.text] : [])));
  const visit = (node: ts.Node): void => {
    if (node !== fn.body && ts.isFunctionLike(node)) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const read =
        node.initializer !== undefined &&
        ts.isPropertyAccessExpression(node.initializer) &&
        ts.isIdentifier(node.initializer.expression) &&
        isFunctionObjectReceiver(node.initializer.expression, resolver);
      candidates.set(node.name.text, read ? (candidates.get(node.name.text) ?? 0) + 1 : Number.POSITIVE_INFINITY);
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      ts.isIdentifier(node.left)
    )
      written.add(node.left.text);
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) &&
      ts.isIdentifier(node.operand)
    )
      written.add(node.operand.text);
    forEachChild(node, visit);
  };
  visit(fn.body);
  return new Set(
    [...candidates].flatMap(([name, count]) =>
      count === 1 && !written.has(name) && !parameters.has(name) ? [name] : [],
    ),
  );
}

/**
 * (#7106 census arm 3) `F.x = G` / `F["x"] = G`: a stable top-level function `G`
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
 * `F["x"] = node` or the chained `F.p.x = node` (see
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

/** Is this member access the target of a write: assignment, `++`/`--`, `delete`, or a for-in/of head? */
export function propertyAccessIsWriteTarget(expression: ts.PropertyAccessExpression): boolean {
  const parent = expression.parent;
  return (
    (ts.isBinaryExpression(parent) &&
      parent.left === expression &&
      parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment) ||
    ((ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) && parent.operand === expression) ||
    (ts.isDeleteExpression(parent) && parent.expression === expression) ||
    ((ts.isForInStatement(parent) || ts.isForOfStatement(parent)) && parent.initializer === expression)
  );
}
