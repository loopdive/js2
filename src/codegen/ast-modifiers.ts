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
