// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * (#6772 S6) A comma-expression heritage: `class D extends (calls++, C) {}`.
 *
 * §15.7.14 step 5 evaluates the ClassHeritage once, at ClassDefinitionEvaluation
 * and in the enclosing scope; its VALUE is the comma's last operand. The
 * standalone collector (`collectClassDeclaration`) resolves a parent only from
 * an identifier or class-expression spelling, so the comma form compiled `D` as
 * an unrelated root struct (no inherited methods, no `instanceof C`) and nothing
 * ever ran `calls++`.
 *
 * {@link standaloneCommaHeritage} peels the comma down to an IDENTIFIER tail —
 * the collector then resolves that exactly as it resolves `extends C` — and
 * {@link emitStandaloneCommaHeritageEffects} evaluates the operands before it
 * at each ClassDefinitionEvaluation site, right after the #5195 r3-5 heritage
 * check (which declines every comma heritage, so nothing is evaluated twice).
 * Standalone / WASI only: the host lane evaluates such a heritage through its
 * dynamic parent registration (`emitRegisterDynamicClassParent`) and is left
 * byte-identical.
 */
import { ts } from "../../ts-api.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { bindingIsUniqueAndNeverWritten } from "../helpers/core-delegates.js"; // (#6797) keeps this leaf out of the codegen SCC

function stripParens(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

/** The identifier whose value is the superclass, and the operands evaluated before it. */
export function standaloneCommaHeritage(
  ctx: CodegenContext,
  decl: ts.ClassLikeDeclaration,
): { readonly value: ts.Identifier; readonly effects: readonly ts.Expression[] } | undefined {
  if (!ctx.standalone && !ctx.wasi) return undefined;
  const clause = decl.heritageClauses?.find((c) => c.token === ts.SyntaxKind.ExtendsKeyword && c.types.length > 0);
  if (clause === undefined) return undefined;
  const effects: ts.Expression[] = [];
  let current = stripParens(clause.types[0]!.expression);
  while (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.CommaToken) {
    effects.push(current.left);
    current = stripParens(current.right);
  }
  return effects.length > 0 && ts.isIdentifier(current) ? { value: current, effects } : undefined;
}

/** Evaluate a comma heritage's leading operands, in order, for their effects. */
export function emitStandaloneCommaHeritageEffects(
  ctx: CodegenContext,
  fctx: FunctionContext,
  decl: ts.ClassLikeDeclaration,
  compileExpression: (ctx: CodegenContext, fctx: FunctionContext, expr: ts.Expression) => unknown,
): void {
  for (const effect of standaloneCommaHeritage(ctx, decl)?.effects ?? []) {
    const produced = compileExpression(ctx, fctx, effect);
    if (typeof (produced as { kind?: unknown } | null)?.kind === "string") fctx.body.push({ op: "drop" });
  }
}

/**
 * True when `childName`'s heritage identifier (a comma heritage's tail
 * included) is bound — uniquely, and never rewritten — to `parentName`'s own
 * declaration, so the collector's NAME-keyed `classParentMap` entry is the value
 * §15.7.14 evaluated. A parameter or alias that merely shares the class's name
 * answers false.
 */
export function heritageBindsParentClass(ctx: CodegenContext, childName: string, parentName: string): boolean {
  const child = ctx.classDeclarationMap.get(childName);
  const parent = ctx.classDeclarationMap.get(parentName);
  const clause = child?.heritageClauses?.find((c) => c.token === ts.SyntaxKind.ExtendsKeyword && c.types.length > 0);
  if (child === undefined || parent === undefined || clause === undefined) return false;
  const tail = standaloneCommaHeritage(ctx, child)?.value ?? stripParens(clause.types[0]!.expression);
  const declaration = ts.isIdentifier(tail) ? ctx.oracle.valueDeclarationOf(tail) : undefined;
  if (declaration === undefined) return false;
  const bindsParent =
    declaration === parent ||
    (ts.isVariableDeclaration(declaration) &&
      declaration.initializer !== undefined &&
      stripParens(declaration.initializer) === parent);
  return bindsParent && bindingIsUniqueAndNeverWritten(tail as ts.Identifier, declaration);
}
