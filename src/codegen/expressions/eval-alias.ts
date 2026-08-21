// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** Compile-order-independent planning for standalone first-class `%eval%`. */
import { ts } from "../../ts-api.js";
import type { TypeOracle } from "../../checker/oracle.js";
import { ensureFuncClosureSingleton } from "../closures/method-trampolines.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { ensureStandaloneIntrinsicEvalWrapper } from "./eval-inline.js";

function resolvesToGlobalEvalAlias(
  ident: ts.Identifier,
  oracle: TypeOracle,
  seen: Set<ts.Declaration> = new Set(),
): boolean {
  if (ident.text !== "eval") {
    const declaration = oracle.valueDeclarationOf(ident);
    if (!declaration || seen.has(declaration)) return false;
    seen.add(declaration);
    if (!ts.isVariableDeclaration(declaration) || !declaration.initializer) return false;
    let initializer: ts.Expression = declaration.initializer;
    while (
      ts.isParenthesizedExpression(initializer) ||
      ts.isAsExpression(initializer) ||
      ts.isNonNullExpression(initializer) ||
      ts.isSatisfiesExpression(initializer) ||
      ts.isTypeAssertionExpression(initializer)
    ) {
      initializer = initializer.expression;
    }
    return ts.isIdentifier(initializer) && resolvesToGlobalEvalAlias(initializer, oracle, seen);
  }
  const declaration = oracle.valueDeclarationOf(ident);
  return declaration === undefined || declaration.getSourceFile().isDeclarationFile;
}

/**
 * Ensure an alias call compiled before `var e = eval` materializes its wrapper
 * still sees that wrapper in the dynamic-call candidate set. The caller keeps
 * loading the live binding, so a later assignment to a mutable alias remains
 * observable instead of being folded to the intrinsic.
 */
export function prepareStandaloneEvalAliasCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  callee: ts.LeftHandSideExpression,
  isKnownVariable: boolean,
): boolean {
  if (
    !isKnownVariable ||
    !ctx.standalone ||
    ctx.runtimeEvalCallableBoundaryEnabled !== true ||
    !ts.isIdentifier(callee) ||
    !resolvesToGlobalEvalAlias(callee, ctx.oracle)
  ) {
    return false;
  }
  const wrapper = ensureStandaloneIntrinsicEvalWrapper(ctx, fctx);
  return wrapper !== undefined && ensureFuncClosureSingleton(ctx, wrapper.fnName, wrapper.funcIdx) !== null;
}
