// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";
import { resolveBuiltinCtorAliasName } from "./native-ordinary-instanceof.js";
import { skipTransparentExpressions } from "./shared.js";
import { bindingHasWriteBefore } from "./single-assignment-binding.js";
import { isBuiltinTypeName } from "./builtin-tags.js";

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
 * Declaration-file builtin constructors and variable initializers are followed
 * when no write to the binding precedes the heritage expression. This keeps a
 * `let`/`var` initializer usable when it is still the live value at the class
 * definition point, while retaining the runtime path for a rebinding that has
 * already happened. Recursive aliases use each alias initializer as their own
 * cutoff, so `const Stable = Mutable; Mutable = Object; class C extends
 * Stable {}` snapshots `Mutable` at `Stable`'s initializer. Cycle detection
 * uses binding declaration identity rather than source names so shadowed
 * aliases cannot interfere.
 */
export function resolveClassHeritageAlias(
  ctx: CodegenContext,
  identifier: ts.Identifier,
  seen = new Set<ts.Declaration>(),
  evaluationNode?: ts.Node,
): string | undefined {
  const declaration = ctx.oracle.valueDeclarationOf(identifier);
  if (declaration === undefined || declaration.getSourceFile().isDeclarationFile) {
    return resolveBuiltinCtorAliasName(ctx, identifier, undefined) ?? resolveHeritageBuiltinCtorName(ctx, identifier);
  }
  if (seen.has(declaration)) return undefined;
  seen.add(declaration);

  // Import bindings and cross-file declarations retain the existing
  // declaration-identity shortcut. Source-order write proofs only make sense
  // for a variable binding declared in the same source file as this use.
  const isLocalVariable =
    ts.isVariableDeclaration(declaration) && declaration.getSourceFile() === identifier.getSourceFile();
  if (!isLocalVariable) {
    const exactClassName = exactClassExpressionTypeName(ctx, ctx.checker.getTypeAtLocation(identifier));
    if (exactClassName !== undefined) return exactClassName;
  }

  if (ts.isClassDeclaration(declaration) && declaration.name) {
    const className = ctx.anonClassExprNames.get(declaration) ?? declaration.name.text;
    return ctx.classSet.has(className) ? className : undefined;
  }
  if (!ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)) return undefined;

  const initializer = ctx.oracle.variableInitializerOf(identifier);
  if (initializer === undefined) return undefined;
  const cutoff = evaluationNode ?? identifier;
  if (bindingHasWriteBefore(ctx, identifier, cutoff)) return undefined;
  const source = skipTransparentExpressions(initializer);
  if (ts.isIdentifier(source)) return resolveClassHeritageAlias(ctx, source, seen, initializer);
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
  return (
    declaration !== undefined &&
    base !== undefined &&
    ts.isIdentifier(base) &&
    heritageIdentifierHasWriteBefore(ctx, base, declaration, new Set<ts.Declaration>())
  );
}

/**
 * Whether a class's heritage value must be read at its declaration point.
 *
 * `classParentMap` can contain either a statically resolved class identity or
 * the original identifier spelling retained as a dynamic fallback. A mutable
 * spelling needs runtime registration even when its initializer currently
 * resolves to a builtin; the dynamic read is what preserves source-order
 * behavior. A class with no parent-map entry is the pre-existing arbitrary
 * runtime-expression path (for example `extends React.Component`).
 */
export function classHeritageRequiresRuntimeParent(ctx: CodegenContext, className: string): boolean {
  const declaration = ctx.classDeclarationMap.get(className);
  const heritage = declaration?.heritageClauses?.find((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword);
  if (declaration === undefined || heritage === undefined || heritage.types.length === 0) return false;
  if (!ctx.classParentMap.has(className)) return true;
  const base = heritage.types[0]?.expression;
  if (base === undefined || !ts.isIdentifier(base)) return true;
  return heritageIdentifierRequiresRuntimeRegistration(ctx, base, declaration, new Set<ts.Declaration>());
}

/** Collect a top-level class only when its heritage must run at module init. */
export function shouldCollectTopLevelClassForRuntimeHeritage(ctx: CodegenContext, statement: ts.Statement): boolean {
  return (
    ts.isClassDeclaration(statement) &&
    statement.name !== undefined &&
    !ctx.standalone &&
    !ctx.wasi &&
    classHeritageRequiresRuntimeParent(ctx, statement.name.text)
  );
}

function resolveHeritageBuiltinCtorName(ctx: CodegenContext, identifier: ts.Identifier): string | undefined {
  if (ctx.oracle.typeFactOf(identifier).kind === "union") return undefined;
  const declaredName = ctx.oracle.declaredNameOf(identifier);
  if (declaredName === undefined || !declaredName.endsWith("Constructor")) return undefined;
  const builtin = declaredName.slice(0, -"Constructor".length);
  return isBuiltinTypeName(builtin) ? builtin : undefined;
}

/** Whether a binding may already have been rebound before this class eval. */
function heritageIdentifierHasWriteBefore(
  ctx: CodegenContext,
  identifier: ts.Identifier,
  evaluationNode: ts.Node,
  seen: Set<ts.Declaration>,
): boolean {
  const declaration = ctx.oracle.valueDeclarationOf(identifier);
  if (declaration === undefined || declaration.getSourceFile().isDeclarationFile) return false;
  if (seen.has(declaration)) return true;
  seen.add(declaration);
  if (ts.isVariableDeclaration(declaration)) {
    const initializer = ctx.oracle.variableInitializerOf(identifier);
    if (initializer === undefined) return true;
    const source = skipTransparentExpressions(initializer);
    const isConst =
      ts.isVariableDeclarationList(declaration.parent) && (declaration.parent.flags & ts.NodeFlags.Const) !== 0;
    if (!isConst) return bindingHasWriteBefore(ctx, identifier, evaluationNode);
    return ts.isIdentifier(source) ? heritageIdentifierHasWriteBefore(ctx, source, initializer, seen) : false;
  }
  return ts.isParameter(declaration) || ts.isBindingElement(declaration);
}

/**
 * Whether the heritage value needs a declaration-point runtime read. Mutable
 * root bindings always do: even when their current initializer resolves to a
 * builtin, the host registration must capture the value at class evaluation.
 * Immutable aliases only need it when their snapshot source cannot be proved
 * statically (or was already changed before the alias initializer).
 */
function heritageIdentifierRequiresRuntimeRegistration(
  ctx: CodegenContext,
  identifier: ts.Identifier,
  evaluationNode: ts.Node,
  seen: Set<ts.Declaration>,
  root = true,
): boolean {
  const declaration = ctx.oracle.valueDeclarationOf(identifier);
  if (declaration === undefined || declaration.getSourceFile().isDeclarationFile) return false;
  if (seen.has(declaration)) return true;
  seen.add(declaration);
  if (ts.isVariableDeclaration(declaration)) {
    const initializer = ctx.oracle.variableInitializerOf(identifier);
    if (initializer === undefined) return true;
    const source = skipTransparentExpressions(initializer);
    const isConst =
      ts.isVariableDeclarationList(declaration.parent) && (declaration.parent.flags & ts.NodeFlags.Const) !== 0;
    if (!isConst) {
      if (root) return true;
      if (bindingHasWriteBefore(ctx, identifier, evaluationNode)) return true;
      return resolveClassHeritageAlias(ctx, identifier, new Set<ts.Declaration>(), evaluationNode) === undefined;
    }
    if (ts.isIdentifier(source)) {
      const resolved = resolveClassHeritageAlias(ctx, identifier, new Set<ts.Declaration>(), evaluationNode);
      if (resolved !== undefined) return false;
      return heritageIdentifierRequiresRuntimeRegistration(ctx, source, initializer, seen, false);
    }
    return true;
  }
  return ts.isParameter(declaration) || ts.isBindingElement(declaration);
}
