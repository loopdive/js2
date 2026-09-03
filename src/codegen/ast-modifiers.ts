// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// ast-modifiers.ts — tiny `ts.getModifiers` / `ts.getCombinedModifierFlags`
// predicate utilities shared across the codegen front-end (#3272, extracted
// verbatim from index.ts). These have zero coupling to codegen context; they
// are pure syntactic classifiers over a `ts.Node`. index.ts re-exports them for
// backward-compatible import paths.

import { ts } from "../ts-api.js";

export function hasExportModifier(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

export function hasDeclareModifier(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return modifiers?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword) ?? false;
}

export function hasAsyncModifier(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false;
}

export function hasAbstractModifier(node: ts.Node): boolean {
  return (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Abstract) !== 0;
}

export function hasStaticModifier(node: ts.Node): boolean {
  return (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Static) !== 0;
}

/** Check if a function declaration is a generator (function*) */
export function isGeneratorFunction(node: ts.FunctionDeclaration): boolean {
  return node.asteriskToken !== undefined;
}

/** Return the one executable constructor, ignoring TypeScript overload signatures. */
export function findConstructorImplementation(
  declaration: ts.ClassDeclaration | ts.ClassExpression,
): ts.ConstructorDeclaration | undefined {
  return declaration.members.find(
    (member): member is ts.ConstructorDeclaration => ts.isConstructorDeclaration(member) && member.body !== undefined,
  );
}

/**
 * (#5195 r3-3) True when a computed-key expression performs a write whose effect
 * is observable after class definition evaluation. `literals.ts::resolveConstantExpression`
 * folds `x = 1` to its RHS for callers that only want the value; used as a KEY
 * that fold silently drops the assignment (`let x = 0; class C { [x = 1]() {} }`
 * left `x` at 0).
 *
 * Consulted ONLY by `class-bodies.ts::resolveInstallableClassMemberName` (the
 * METHOD/ACCESSOR lane, standalone). Class FIELDS and object literals keep the
 * fold: their install lanes cannot take a runtime key today, so declining there
 * turns a wrong-`x` program into a missing-property one — strictly worse.
 */
export function computedKeyPerformsWrite(expr: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(expr)) return computedKeyPerformsWrite(expr.expression);
  return ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.EqualsToken;
}
