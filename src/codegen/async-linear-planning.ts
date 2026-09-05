// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * Front-end proof for the first AST-free multi-await producer.
 *
 * This module intentionally returns only the exact await sites and their
 * source expressions.  `IrAsyncPlan` is built later from the lowered IR and
 * therefore never carries an AST, checker object, or a codegen callback.
 */

import type { CodegenContext } from "./context/types.js";
import { analyzeAsyncBody, planLinearAwaits } from "./async-cps.js";
import { ts } from "../ts-api.js";

export interface PreparedIrAsyncLinearSource {
  readonly kind: "linear";
  readonly awaitSites: readonly ts.AwaitExpression[];
  readonly awaitedExpressions: readonly ts.Expression[];
}

function isNestedExecutable(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  );
}

/**
 * Keep this proof deliberately structural.  A flat IR block is required by
 * the producer, so accepting a source branch or loop here would make source
 * ownership disagree with the post-lowering producer.
 */
function containsUnsupportedControl(body: ts.Block): boolean {
  let unsupported = false;
  const visit = (node: ts.Node): void => {
    if (unsupported) return;
    // A nested executable owns a separate activation and can hide an await or
    // capture a value that the flat producer cannot represent.  Refuse the
    // outer owner as soon as one is encountered instead of skipping its body
    // and accidentally certifying only the visible top-level statements.
    if (isNestedExecutable(node)) {
      unsupported = true;
      return;
    }
    if (
      ts.isIfStatement(node) ||
      ts.isSwitchStatement(node) ||
      ts.isForStatement(node) ||
      ts.isForInStatement(node) ||
      ts.isForOfStatement(node) ||
      ts.isWhileStatement(node) ||
      ts.isDoStatement(node) ||
      ts.isTryStatement(node) ||
      ts.isWithStatement(node) ||
      ts.isLabeledStatement(node) ||
      ts.isThrowStatement(node)
    ) {
      unsupported = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  for (const statement of body.statements) visit(statement);
  return unsupported;
}

function hasNonFinalReturn(body: ts.Block): boolean {
  for (let index = 0; index < body.statements.length; index++) {
    const statement = body.statements[index]!;
    if (!ts.isReturnStatement(statement)) continue;
    if (index !== body.statements.length - 1) return true;
  }
  return false;
}

/**
 * Prove one top-level straight-line async declaration for B2.
 *
 * `planLinearAwaits` remains the shared source-shape preflight, while this
 * wrapper removes its broader try/finally and control-flow population.  The
 * exact sites are retained in source order so AST lowering can preserve every
 * suspension, including statically settled operands.
 */
export function preparedIrAsyncLinearSource(
  ctx: CodegenContext,
  fn: ts.FunctionLikeDeclaration,
): PreparedIrAsyncLinearSource | null {
  if (
    !ts.isFunctionDeclaration(fn) ||
    fn.asteriskToken ||
    !fn.body ||
    !ts.isBlock(fn.body) ||
    fn.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) !== true
  ) {
    return null;
  }
  if (containsUnsupportedControl(fn.body) || hasNonFinalReturn(fn.body)) return null;

  const cps = analyzeAsyncBody(ctx, fn);
  if (cps.awaitPoints.length === 0) return null;
  const linear = planLinearAwaits(fn, cps, { checker: ctx.checker });
  if (!linear || linear.finalizer !== null || linear.tailInTry.some(Boolean)) return null;
  if (linear.segments.some((segment) => segment.awaitInTry || segment.leadInTry.some(Boolean))) return null;
  if (linear.segments.length !== cps.awaitPoints.length) return null;

  // The shared analyzer reports awaits pre-order.  The flat source proof has
  // no nested executable/control region, so segment order must be identical;
  // retain that identity as an invariant rather than silently reordering it.
  const awaitSites = cps.awaitPoints.slice();
  const awaitedExpressions = linear.segments.map((segment) => segment.awaitedExpr);
  if (awaitedExpressions.length !== awaitSites.length) return null;
  return { kind: "linear", awaitSites, awaitedExpressions };
}
