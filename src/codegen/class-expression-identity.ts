// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";
import { resolveBuiltinCtorAliasName } from "./native-ordinary-instanceof.js";
import { skipTransparentExpressions } from "./shared.js";

/**
 * Resolve a class-expression type by declaration identity.
 *
 * TypeScript gives unrelated anonymous class expressions the same `__class`
 * display name. That string is useful only as a compatibility fallback; the
 * declaration node is the stable identity across local and imported uses.
 */
export function exactClassExpressionTypeName(ctx: CodegenContext, type: ts.Type): string | undefined {
  const symbol = type.getSymbol();
  for (const declaration of symbol?.getDeclarations() ?? []) {
    let candidate: ts.Node = declaration;
    if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
      candidate = declaration.initializer;
      while (
        ts.isParenthesizedExpression(candidate) ||
        ts.isAsExpression(candidate) ||
        ts.isNonNullExpression(candidate) ||
        ts.isSatisfiesExpression(candidate) ||
        ts.isTypeAssertionExpression(candidate)
      ) {
        candidate = candidate.expression;
      }
    }
    // (#4618) A nested class DECLARATION whose name collided with a class in
    // another scope carries the same per-site synthetic identity (see
    // collectClassesFromStatements) — resolve it by declaration node exactly
    // like an anonymous class expression.
    if (!ts.isClassExpression(candidate) && !ts.isClassDeclaration(candidate)) continue;
    const syntheticName = ctx.anonClassExprNames.get(candidate);
    if (syntheticName && ctx.structMap.has(syntheticName)) return syntheticName;
  }
  return undefined;
}

/**
 * Resolve a class-heritage name before registering the class's parent. The
 * collector used to retain only the alias spelling, so `const A = RegExp;
 * class S extends A {}` never populated the builtin-parent map. The same
 * omission affects aliases of user classes and other builtins (for example the
 * Array subclass consumed by flatMap lowering).
 *
 * Only declaration-file builtin constructors and plain `const` variable
 * initializers are followed. A `let`/`var`, import, conditional expression,
 * or cyclic declaration returns `undefined`; the caller then retains its old
 * spelling and dynamic behavior. Cycle detection uses binding declaration
 * identity rather than source names so shadowed aliases cannot interfere.
 */
export function resolveClassHeritageAlias(
  ctx: CodegenContext,
  identifier: ts.Identifier,
  seen = new Set<ts.Declaration>(),
): string | undefined {
  const declaration = ctx.oracle.valueDeclarationOf(identifier);
  // A local `let`/`var` initialized with a class expression can be reassigned
  // before the heritage clause runs.  Do not let its checker type freeze the
  // initializer as the runtime parent; only an immutable local binding may use
  // the exact class-expression identity shortcut.  Import bindings retain the
  // existing #4291 declaration-identity path.
  if (heritageIdentifierHasMutableBinding(ctx, identifier)) return undefined;
  const exactClassName = exactClassExpressionTypeName(ctx, ctx.checker.getTypeAtLocation(identifier));
  if (exactClassName !== undefined) return exactClassName;
  if (declaration === undefined || declaration.getSourceFile().isDeclarationFile) {
    return resolveBuiltinCtorAliasName(ctx, identifier, undefined);
  }
  if (seen.has(declaration)) return undefined;
  seen.add(declaration);

  if (ts.isClassDeclaration(declaration) && declaration.name) {
    const className = ctx.anonClassExprNames.get(declaration) ?? declaration.name.text;
    return ctx.classSet.has(className) ? className : undefined;
  }
  if (!ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)) return undefined;

  const initializer = ctx.oracle.constInitializerOf(identifier);
  if (initializer === undefined) return undefined;
  const source = skipTransparentExpressions(initializer);
  if (ts.isIdentifier(source)) return resolveClassHeritageAlias(ctx, source, seen);
  if (ts.isClassExpression(source)) {
    const className = ctx.anonClassExprNames.get(source);
    return className !== undefined && ctx.classSet.has(className) ? className : undefined;
  }
  return undefined;
}

/** Whether a compiled class's `extends` identifier can change at runtime. */
export function classHasMutableHeritageBinding(ctx: CodegenContext, className: string): boolean {
  const declaration = ctx.classDeclarationMap.get(className);
  const heritage = declaration?.heritageClauses?.find((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword);
  const base = heritage?.types[0]?.expression;
  return base !== undefined && ts.isIdentifier(base) && heritageIdentifierHasMutableBinding(ctx, base);
}

function heritageIdentifierHasMutableBinding(ctx: CodegenContext, identifier: ts.Identifier): boolean {
  const declaration = ctx.oracle.valueDeclarationOf(identifier);
  if (declaration === undefined || declaration.getSourceFile().isDeclarationFile) return false;
  if (ts.isVariableDeclaration(declaration)) return ctx.oracle.constInitializerOf(identifier) === undefined;
  return ts.isParameter(declaration) || ts.isBindingElement(declaration);
}
