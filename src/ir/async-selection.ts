// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../ts-api.js";

/** Async-specific selector evidence supplied by the codegen preparation layer. */
export interface IrAsyncSelectionOptions {
  /** Enables the shared CPS/IR async producer for this backend. */
  readonly supportsAsyncIr?: boolean;
  /** Authoritative verdict from the single converged async engine. */
  readonly asyncEngineClaims?: (fn: ts.FunctionLikeDeclaration) => boolean;
  /** Exact producer proof for a real suspension represented by IrAsyncPlan. */
  readonly canPrepareSuspendingAsync?: (fn: ts.FunctionLikeDeclaration) => boolean;
  /** True when shared analysis finds at least one non-static await. */
  readonly asyncHasRealSuspension?: (fn: ts.FunctionLikeDeclaration) => boolean;
  /** Exact Promise<number>[] pending-vector representation proof. */
  readonly preparedAsyncPromiseVectorLocal?: (declaration: ts.VariableDeclaration) => boolean;
  /** Exact pending-Promise producer call owned by a prepared prefix. */
  readonly preparedAsyncThenableCall?: (call: ts.CallExpression) => boolean;
  /** Exact awaited Promise.all call owned by a prepared continuation. */
  readonly preparedAsyncPromiseAllCall?: (call: ts.CallExpression) => boolean;
  /** Exact ambient Date.now call owned by the final prepared main. */
  readonly preparedAsyncDateNowCall?: (call: ts.CallExpression) => boolean;
}

/** Central async ownership gate shared by production selection and tests. */
export function isAsyncIrReady(options: IrAsyncSelectionOptions | undefined, fn: ts.FunctionLikeDeclaration): boolean {
  if (!options?.supportsAsyncIr || !ts.isFunctionDeclaration(fn) || fn.asteriskToken || !fn.body) return false;
  if (options.asyncEngineClaims === undefined) return false;
  if (options.asyncEngineClaims(fn)) return options.canPrepareSuspendingAsync?.(fn) === true;
  if (options.asyncHasRealSuspension?.(fn) === true) return options.canPrepareSuspendingAsync?.(fn) === true;
  return !bodyHasAsyncOutOfIrScope(fn.body);
}

/** Return the certified Promise.all arguments, excluding spread shapes. */
export function preparedAsyncPromiseAllArguments(
  expression: ts.Expression,
  options: IrAsyncSelectionOptions | undefined,
): readonly ts.Expression[] | null {
  if (
    !ts.isCallExpression(expression) ||
    options?.preparedAsyncPromiseAllCall?.(expression) !== true ||
    expression.arguments.some(ts.isSpreadElement)
  ) {
    return null;
  }
  return expression.arguments;
}

/** Reject unawaited async calls unless the prepared prefix owns the exact site. */
export function isUnpreparedAsyncCallee(
  call: ts.CallExpression,
  scope: ReadonlySet<string>,
  asyncNames: ReadonlySet<string>,
  options: IrAsyncSelectionOptions | undefined,
): boolean {
  return (
    ts.isIdentifier(call.expression) &&
    asyncNames.has(call.expression.text) &&
    !scope.has(call.expression.text) &&
    options?.preparedAsyncThenableCall?.(call) !== true
  );
}

function bodyHasAsyncOutOfIrScope(body: ts.Node): boolean {
  let found = false;
  const walk = (node: ts.Node): void => {
    if (found) return;
    if (ts.isForOfStatement(node) && node.awaitModifier) {
      found = true;
      return;
    }
    if (
      (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)) &&
      node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, walk);
  };
  ts.forEachChild(body, walk);
  return found;
}
