// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";

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
    if (!ts.isClassExpression(candidate)) continue;
    const syntheticName = ctx.anonClassExprNames.get(candidate);
    if (syntheticName && ctx.structMap.has(syntheticName)) return syntheticName;
  }
  return undefined;
}
