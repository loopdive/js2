// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * (#7108) Selector admission for the array methods `./vec-search-join.ts`
 * lowers. The selector asks this module BEFORE it walks the receiver and the
 * arguments; a `false`-free answer means "the IR lowers this call when its
 * operands are Phase-1", a rejection names the arm that refused.
 *
 * Admission is deliberately the exact domain of the lowering, so a claimed
 * call never demotes at build time:
 *   - the receiver's element family is `number` or `string` (checker proof,
 *     supplied by the backend integration through
 *     {@link makeIrArrayElementFamilyClassifier}; a backend that does not
 *     supply it — the linear lane — admits nothing);
 *   - `indexOf(x)` / `includes(x)`: exactly one non-spread argument whose
 *     family equals the element family (no `fromIndex`, no coercion);
 *   - `join()` / `join(sep)`: at most one non-spread argument, and a present
 *     separator is a proven string.
 */

import type { TypeOracle } from "../../checker/oracle.js";
import { ts } from "../../ts-api.js";
import { inferEmptyArrayElementTypes, type EmptyArrayElementInference } from "../array-element-inference.js";
import { IR_VEC_SEARCH_JOIN_METHODS } from "./vec-search-join.js";

/** Element family of an array-typed expression the IR can scan. */
export type IrArrayElementFamily = "number" | "string";

export interface IrVecSearchJoinSelection {
  /** Checker-backed element family of the receiver; absent ⇒ admit nothing. */
  readonly elementFamily?: (receiver: ts.Expression) => IrArrayElementFamily | undefined;
  /** Proven primitive family of an argument expression. */
  readonly argumentFamily: (argument: ts.Expression) => string | undefined;
}

export type IrVecSearchJoinVerdict =
  | { readonly admitted: true }
  | { readonly admitted: false; readonly arm: string; readonly node: ts.Node };

/**
 * `undefined` when `call` is not one of the owned methods (the caller keeps
 * its existing handling), otherwise the admission verdict.
 */
export function selectVecSearchOrJoin(
  call: ts.CallExpression,
  options: IrVecSearchJoinSelection,
): IrVecSearchJoinVerdict | undefined {
  if (!ts.isPropertyAccessExpression(call.expression)) return undefined;
  const method = call.expression.name.text;
  if (!IR_VEC_SEARCH_JOIN_METHODS.has(method)) return undefined;
  const family = options.elementFamily?.(call.expression.expression);
  if (family === undefined) return { admitted: false, arm: "expr-array-search-element-family", node: call };
  if (call.arguments.some(ts.isSpreadElement)) {
    return { admitted: false, arm: "expr-array-search-shape", node: call };
  }
  if (method === "join") {
    if (call.arguments.length > 1) return { admitted: false, arm: "expr-array-join-shape", node: call };
    const separator = call.arguments[0];
    if (separator !== undefined && options.argumentFamily(separator) !== "string") {
      return { admitted: false, arm: "expr-array-join-separator", node: separator };
    }
    return { admitted: true };
  }
  if (call.arguments.length !== 1) return { admitted: false, arm: "expr-array-search-shape", node: call };
  if (options.argumentFamily(call.arguments[0]!) !== family) {
    return { admitted: false, arm: "expr-array-search-value-family", node: call.arguments[0]! };
  }
  return { admitted: true };
}

function primitiveFamily(type: ts.Type): IrArrayElementFamily | undefined {
  const members = type.isUnion() ? type.types : [type];
  let family: IrArrayElementFamily | undefined;
  for (const member of members) {
    const flags = member.flags;
    const memberFamily: IrArrayElementFamily | undefined =
      (flags & ts.TypeFlags.NumberLike) !== 0 && (flags & ts.TypeFlags.EnumLike) === 0
        ? "number"
        : (flags & ts.TypeFlags.StringLike) !== 0 && (flags & ts.TypeFlags.EnumLike) === 0
          ? "string"
          : undefined;
    if (memberFamily === undefined || (family !== undefined && family !== memberFamily)) return undefined;
    family = memberFamily;
  }
  return family;
}

function isDenseArrayLiteral(node: ts.Node | undefined): boolean {
  return (
    node !== undefined &&
    ts.isArrayLiteralExpression(node) &&
    node.elements.length > 0 &&
    node.elements.every((element) => !ts.isSpreadElement(element) && !ts.isOmittedExpression(element))
  );
}

/**
 * A string vec is only scanned when the IR itself materialized it: an array
 * literal, or a `const` bound to one. A `string[]` that crosses a call or a
 * module boundary keeps its elements in the boxed externref carrier, which
 * this slice does not unbox — so it is refused here rather than claimed and
 * demoted at build time.
 */
function isLiteralStringVec(node: ts.Expression, checker: ts.TypeChecker): boolean {
  if (isDenseArrayLiteral(node)) return true;
  if (!ts.isIdentifier(node)) return false;
  const declaration = checker.getSymbolAtLocation(node)?.valueDeclaration;
  return (
    declaration !== undefined &&
    ts.isVariableDeclaration(declaration) &&
    ts.isVariableDeclarationList(declaration.parent) &&
    (declaration.parent.flags & ts.NodeFlags.Const) !== 0 &&
    isDenseArrayLiteral(declaration.initializer)
  );
}

type InferenceFunction = Parameters<typeof inferEmptyArrayElementTypes>[0];

function isInferenceFunction(node: ts.Node): node is InferenceFunction {
  return (
    (ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node)) &&
    node.body !== undefined
  );
}

/**
 * (#7122) An identifier bound in this function to `[]` whose may-alias group
 * the empty-array inference closes as `string[]` — the exact proof from-ast
 * consults to allocate it as a vec of the string carrier, so the selector and
 * the lowering cannot disagree. Every store into such a vec is a `.push` of a
 * proven string (no holes, no coercion).
 */
function isInferredStringVec(
  node: ts.Expression,
  checker: ts.TypeChecker,
  oracle: TypeOracle,
  cache: WeakMap<InferenceFunction, EmptyArrayElementInference>,
): boolean {
  if (!ts.isIdentifier(node)) return false;
  const declaration = checker.getSymbolAtLocation(node)?.valueDeclaration;
  if (
    declaration === undefined ||
    !ts.isVariableDeclaration(declaration) ||
    declaration.initializer === undefined ||
    !ts.isArrayLiteralExpression(declaration.initializer) ||
    declaration.initializer.elements.length !== 0
  ) {
    return false;
  }
  let fn: ts.Node | undefined = declaration.parent;
  while (fn !== undefined && !isInferenceFunction(fn)) fn = fn.parent;
  if (fn === undefined) return false;
  let use: ts.Node | undefined = node.parent;
  while (use !== undefined && use !== fn && !isInferenceFunction(use)) use = use.parent;
  if (use !== fn) return false;
  let inference = cache.get(fn);
  if (inference === undefined) {
    inference = inferEmptyArrayElementTypes(fn, oracle);
    cache.set(fn, inference);
  }
  const result = inference.resultForLiteral(declaration.initializer);
  return result?.kind === "resolved" && result.elementKind === "string";
}

/**
 * Checker-backed element family of an expression whose type is a plain
 * `Array<T>` (not a tuple, not a union of arrays) with `T` entirely `number`
 * or entirely `string` (the latter only for an IR-materialized literal vec,
 * see {@link isLiteralStringVec}, or an empty literal the inference closes as
 * `string[]`, see {@link isInferredStringVec}).
 */
export function makeIrArrayElementFamilyClassifier(
  checker: ts.TypeChecker,
  oracle: TypeOracle,
): (expr: ts.Expression) => IrArrayElementFamily | undefined {
  const inferenceCache = new WeakMap<InferenceFunction, EmptyArrayElementInference>();
  return (expr) => {
    try {
      let node: ts.Expression = expr;
      while (ts.isParenthesizedExpression(node)) node = node.expression;
      if (isInferredStringVec(node, checker, oracle, inferenceCache)) return "string";
      const type = checker.getTypeAtLocation(node);
      if (!checker.isArrayType(type)) return undefined;
      const element = checker.getTypeArguments(type as ts.TypeReference)[0];
      const family = element === undefined ? undefined : primitiveFamily(element);
      return family === "string" && !isLiteralStringVec(node, checker) ? undefined : family;
    } catch {
      return undefined;
    }
  };
}
