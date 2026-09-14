// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts, forEachChild } from "../../ts-api.js";
import type { CodegenContext } from "../context/types.js";
import { expressionHasWidenedPropertyType } from "../strict-eq-stale-type.js";

/** A return inferred from an alias-mutated property needs its runtime carrier. */
export function functionReturnsWidenedProperty(ctx: CodegenContext, fn: ts.FunctionDeclaration): boolean {
  if (!fn.body || fn.type || ctx.objectLiteralIndexedAssignedPropertyTypes.size === 0) return false;
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found || ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node) && node.expression && expressionHasWidenedPropertyType(ctx, node.expression)) {
      found = true;
      return;
    }
    forEachChild(node, visit);
  };
  visit(fn.body);
  return found;
}
