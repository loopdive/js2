// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// ast-modifiers.ts — tiny `ts.getModifiers` / `ts.getCombinedModifierFlags`
// predicate utilities shared across the codegen front-end (#3272, extracted
// verbatim from index.ts). These have zero coupling to codegen context; they
// are pure syntactic classifiers over a `ts.Node`. index.ts re-exports them for
// backward-compatible import paths.

import { ts } from "../ts-api.js";
import type { TypeOracle } from "../checker/oracle.js";
import { nativeTypeOfDeclaration } from "./native-type-annotations.js";

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

/**
 * (#5195 r3-4) `static constructor(){}` — TS parses it as a
 * ConstructorDeclaration carrying a `static` modifier, but per §15.7 it is an
 * ordinary static METHOD whose PropName is "constructor", NOT the class's
 * [[Construct]] body. A class may legally carry both it and a real constructor.
 */
export function isStaticCtorMethod(member: ts.ClassElement): boolean {
  return ts.isConstructorDeclaration(member) && hasStaticModifier(member) && member.body !== undefined;
}

/** Return the one executable constructor, ignoring TypeScript overload signatures. */
export function findConstructorImplementation(
  declaration: ts.ClassDeclaration | ts.ClassExpression,
): ts.ConstructorDeclaration | undefined {
  return declaration.members.find(
    (member): member is ts.ConstructorDeclaration =>
      ts.isConstructorDeclaration(member) && member.body !== undefined && !isStaticCtorMethod(member),
  );
}

/**
 * (#7215) The constructor's TypeScript parameter properties
 * (`constructor(public x: T)`, also `private`/`protected`/`readonly`/`override`),
 * in parameter order. Each declares an own field and implies `this.x = x`
 * right after the field initializers (TS ES2022 emit). Binding patterns are
 * a TS error here and are skipped.
 */
export function constructorParameterProperties(
  ctor: ts.ConstructorDeclaration | undefined,
): (ts.ParameterDeclaration & { name: ts.Identifier })[] {
  if (!ctor) return [];
  return ctor.parameters.filter(
    (p): p is ts.ParameterDeclaration & { name: ts.Identifier } =>
      ts.isParameterPropertyDeclaration(p, ctor) && ts.isIdentifier(p.name),
  );
}

/**
 * (#7215) Whether a parameter property's value fits an ordinary field yet. Not when it is natively annotated
 * (`public n: i32` — the IR-compiled methods reject an `i32` field), nor when it may be `undefined`: an omitted
 * `s?: string`, a `string | undefined` argument, or a default that is itself `undefined` (`= void 0`). No field
 * slot holds `undefined` yet, so it would read `null`/`0`/`false`.
 */
export function parameterPropertyCanHaveField(oracle: TypeOracle, param: ts.ParameterDeclaration): boolean {
  if (nativeTypeOfDeclaration(oracle, param) !== null) return false;
  const mayBeUndefined = param.initializer
    ? oracle.nullabilityOf(param.initializer).undefinable
    : param.questionToken !== undefined || oracle.nullabilityOf(param).undefinable;
  return !mayBeUndefined;
}
