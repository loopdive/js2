// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { ts } from "../ts-api.js";
import { ts as tsApi } from "../ts-api.js";
import type { LinearContext, LinearFuncContext } from "./context.js";

/**
 * Compile an Array receiver to its current linear-memory header.
 *
 * Growing arrays leave forwarding headers so aliases remain valid. For a
 * local identifier, cache the resolved pointer back into the local so later
 * operations do not walk the full historical growth chain again.
 */
export function compileResolvedArrayPointer(
  ctx: LinearContext,
  fctx: LinearFuncContext,
  expression: ts.Expression,
  compileExpression: (ctx: LinearContext, fctx: LinearFuncContext, expression: ts.Expression) => void,
): void {
  compileExpression(ctx, fctx, expression);
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__arr_resolve")! });
  if (tsApi.isIdentifier(expression)) {
    const localIdx = fctx.localMap.get(expression.text);
    if (localIdx !== undefined) fctx.body.push({ op: "local.tee", index: localIdx });
  }
}

/** Push a local array's current header and retain it for the next operation. */
export function emitResolvedArrayLocal(ctx: LinearContext, fctx: LinearFuncContext, localIdx: number): void {
  fctx.body.push(
    { op: "local.get", index: localIdx },
    { op: "call", funcIdx: ctx.funcMap.get("__arr_resolve")! },
    { op: "local.tee", index: localIdx },
  );
}
