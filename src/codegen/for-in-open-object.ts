// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** Selection of the live open-object representation for standalone for-in. */
import { ts } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";
import { resolveWidenedVarKey } from "./widened-var-key.js";

/**
 * Whether a direct identifier receiver is allocated as an open/growable
 * object. The checker type can remain a closed object literal even after the
 * IR planner has selected the live carrier, so for-in must consult that same
 * declaration-scoped decision before static unrolling.
 */
export function isOpenForInReceiver(ctx: CodegenContext, expression: ts.Expression): boolean {
  let receiver: ts.Expression = expression;
  while (ts.isParenthesizedExpression(receiver)) receiver = receiver.expression;
  if (!ts.isIdentifier(receiver)) return false;
  const key = resolveWidenedVarKey(ctx, receiver);
  return (
    ctx.growableObjectLiteralVars.has(receiver.text) || (key !== undefined && ctx.irWithOpenObjectTargetKeys.has(key))
  );
}
