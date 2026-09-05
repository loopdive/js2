// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import ts from "typescript";
import type { CodegenContext } from "./context/types.js";

/**
 * A literal passed directly to `any` needs per-element boxing unless every
 * element is an ordinary number. Otherwise its inferred carrier can erase JS
 * tags or become unreadable through the dynamic parameter ABI.
 */
export function bareAnyArrayLiteralNeedsExternref(
  ctx: CodegenContext,
  expr: ts.ArrayLiteralExpression,
  isUndefinedLike: (node: ts.Node) => boolean,
): boolean {
  if (ctx.oracle.contextualFactOf(expr)?.kind !== "any") return false;
  return !expr.elements.every((element) => {
    if (ts.isOmittedExpression(element) || isUndefinedLike(element) || ts.isSpreadElement(element)) return false;
    return ctx.oracle.staticJsTypeOf(element) === "number";
  });
}
