// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Duplicate-label early-error rules (#1931). Extracted verbatim from
// detectEarlyErrors; the only change is threading an EarlyErrorContext.
import { ts, forEachChild } from "../../ts-api.js";
import type { EarlyErrorContext } from "./context.js";

/**
 * Check for duplicate label names in a block (for class static block bodies).
 * ES spec: ContainsDuplicateLabels must be false.
 * Does not cross function boundaries.
 */
export function checkDuplicateLabelsInBlock(ctx: EarlyErrorContext, block: ts.Block): void {
  const labels = new Set<string>();
  function walkForLabels(node: ts.Node): void {
    // Don't cross function/class boundaries
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isClassExpression(node)
    ) {
      return;
    }
    if (ts.isLabeledStatement(node)) {
      const label = node.label.text;
      if (labels.has(label)) {
        ctx.addError(node.label, `Duplicate label '${label}' in class static block`);
      } else {
        labels.add(label);
        walkForLabels(node.statement);
        labels.delete(label);
      }
      return;
    }
    forEachChild(node, walkForLabels);
  }
  forEachChild(block, walkForLabels);
}

/**
 * Check for duplicate (nested, not sibling) label names — always a SyntaxError.
 * ES spec: ContainsDuplicateLabels of StatementList must be false.
 */
export function checkDuplicateLabels(ctx: EarlyErrorContext, node: ts.Node, activeLabels: Set<string>): void {
  // Don't cross function/class boundaries
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isClassExpression(node)
  ) {
    return;
  }
  if (ts.isLabeledStatement(node)) {
    const label = node.label.text;
    if (activeLabels.has(label)) {
      ctx.addError(node.label, `Duplicate label '${label}'`);
    } else {
      activeLabels.add(label);
      checkDuplicateLabels(ctx, node.statement, activeLabels);
      activeLabels.delete(label);
    }
    return;
  }
  forEachChild(node, (child) => checkDuplicateLabels(ctx, child, activeLabels));
}
