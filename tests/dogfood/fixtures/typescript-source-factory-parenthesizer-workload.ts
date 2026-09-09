// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Full-source factory triage; numeric checks do not require Debug enum formatting.
import * as ts from "../.npm-upstream-suites/typescript/src/compiler/_namespaces/ts.js";

export function runObject(): number {
  return ts.factory.createObjectLiteralExpression().kind === ts.SyntaxKind.ObjectLiteralExpression ? 1 : 0;
}

export function runWrappedObject(): number {
  const node = ts.factory.createObjectLiteralExpression();
  return ts.factory.createParenthesizedExpression(node).expression === node ? 1 : 0;
}

export function runLeftmost(): number {
  const node = ts.factory.createObjectLiteralExpression();
  return ts.getLeftmostExpression(node, false) === node ? 1 : 0;
}

export function runSkipPartial(): number {
  const node = ts.factory.createObjectLiteralExpression();
  return ts.skipPartiallyEmittedExpressions(node) === node ? 1 : 0;
}

export function runDirectNoWrap(): number {
  const node = ts.factory.createIdentifier("x");
  return ts.factory.parenthesizer.parenthesizeExpressionOfExportDefault(node) === node ? 1 : 0;
}

export function runFreshConcise(): number {
  const node = ts.factory.createObjectLiteralExpression();
  const rules = ts.createParenthesizerRules(ts.factory);
  return rules.parenthesizeConciseBodyOfArrowFunction(node).kind === ts.SyntaxKind.ParenthesizedExpression ? 1 : 0;
}

export function runFreshExport(): number {
  const node = ts.factory.createClassExpression(undefined, "C", undefined, undefined, []);
  const rules = ts.createParenthesizerRules(ts.factory);
  return rules.parenthesizeExpressionOfExportDefault(node).kind === ts.SyntaxKind.ParenthesizedExpression ? 1 : 0;
}

export function runClass(): number {
  return ts.factory.createClassExpression(undefined, "C", undefined, undefined, []).kind ===
    ts.SyntaxKind.ClassExpression
    ? 1
    : 0;
}

export function runDirectConcise(): number {
  const node = ts.factory.createObjectLiteralExpression();
  return ts.factory.parenthesizer.parenthesizeConciseBodyOfArrowFunction(node).kind ===
    ts.SyntaxKind.ParenthesizedExpression
    ? 1
    : 0;
}

export function runDirectExport(): number {
  const node = ts.factory.createClassExpression(undefined, "C", undefined, undefined, []);
  return ts.factory.parenthesizer.parenthesizeExpressionOfExportDefault(node).kind ===
    ts.SyntaxKind.ParenthesizedExpression
    ? 1
    : 0;
}

export function runArrow(): number {
  const node = ts.factory.createObjectLiteralExpression();
  return ts.factory.createArrowFunction(undefined, undefined, [], undefined, undefined, node).body.kind ===
    ts.SyntaxKind.ParenthesizedExpression
    ? 1
    : 0;
}

export function runExport(): number {
  const node = ts.factory.createClassExpression(undefined, "C", undefined, undefined, []);
  return ts.factory.createExportAssignment(undefined, false, node).expression.kind ===
    ts.SyntaxKind.ParenthesizedExpression
    ? 1
    : 0;
}
