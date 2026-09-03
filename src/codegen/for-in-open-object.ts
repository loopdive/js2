// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** Selection of the live open-object representation for standalone for-in. */
import { ts } from "../ts-api.js";
import { forInReceiverIsDynamic } from "./builtin-instance-key-presence.js";
import type { CodegenContext } from "./context/types.js";
import type { ValType } from "../ir/types.js";
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

/**
 * (#5310) Whether a for-in receiver needs the DYNAMIC key enumerators
 * (`__for_in_*` in JS-host mode, the `$Object` runtime helpers in a no-JS-host
 * target) rather than the static unroll.
 *
 * This has to be answered from the receiver's lowered REPRESENTATION. The
 * enumeration site used to answer it from whether the host imports happened to
 * be REGISTERED, which made the two targets disagree: a closed WasmGC struct
 * does not lower to `$Object`, so the dynamic enumerators cannot see its
 * fields, and standalone therefore fell through to the static unroll — exact
 * for a non-mutated closed shape. In host mode the imports exist, so the struct
 * was wrapped with `extern.convert_any` and handed to a JS function that sees
 * an opaque WasmGC value and returns zero keys. `for (const k in { a: 1 })`
 * silently ran its body zero times.
 */
export function forInReceiverNeedsDynamicKeys(
  ctx: CodegenContext,
  expression: ts.Expression,
  receiverWasmType: ValType,
): boolean {
  return isOpenForInReceiver(ctx, expression) || forInReceiverIsDynamic(ctx, receiverWasmType);
}
