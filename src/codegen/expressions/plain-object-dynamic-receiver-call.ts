// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4269) `obj[k]()` on a plain-object receiver — the runtime-key twin of the
 * object-literal method receiver bind.
 *
 * #4252 routed this shape through `tryEmitInlineDynamicCall`, which fixed the
 * larger half: the callee had not been INVOKED at all. It still runs with no
 * receiver, so `var obj = { x: 42, m: function () { return this.x; } };
 * var k = "m"; obj[k]()` answers `undefined` rather than 42 — the same missing
 * `__current_this` writer, one dispatch layer down.
 *
 * This is a WRAPPER around #4252's dispatch rather than an edit inside it, for
 * a reason: `tryEmitInlineDynamicCall` also serves bare identifier calls
 * (`f()`), where there is no receiver at all and an install would be
 * meaningless. The wrapper is reached only from the two plain-object
 * element-access arms.
 *
 * ## The declined case
 *
 * The install must precede the dispatch (which compiles the callee AND the
 * arguments itself), but the dispatch can still return `null` — it declines
 * when it finds no admissible candidate, and the caller then falls through to
 * the drop-everything arm. The install is therefore paired with a bare RESTORE
 * on that path. Leaving it standing would leak the receiver into the rest of
 * the frame as `this`, which is worse than the defect being fixed.
 *
 * The declined path is not rolled back. Truncating the body would also discard
 * whatever the dispatch itself emitted before declining (it compiles the callee
 * first), and that evaluation is observable. So a shape the plan ADMITS but the
 * dispatch declines keeps every instruction it had before, plus an inert
 * capture + save/restore pair. Byte-identity is claimed only for shapes the
 * plan refuses — which is every shape whose receiver is not an object literal
 * carrying a `this`-reading function property.
 */
import type { ts } from "../../ts-api.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import type { InnerResult } from "../shared.js";
import { compileExpression } from "../shared.js";
import {
  emitObjectLiteralMethodThisInstall,
  emitObjectLiteralMethodThisRestore,
  emitStandaloneReceiverCapture,
  finishObjectLiteralMethodCall,
  planDynamicElementReceiverBind,
} from "../object-literal-method-receiver.js";
import { tryEmitInlineDynamicCall } from "./calls.js";

/**
 * #4252's dynamic dispatch for a plain-object element-access call, with the
 * receiver installed as `this` when the receiver's object literal admits it.
 * Returns exactly what `tryEmitInlineDynamicCall` returns, so the caller's
 * `null` fall-through is unchanged.
 */
export function emitPlainObjectDynamicCallWithReceiver(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  elemAccess: ts.ElementAccessExpression,
): InnerResult | null {
  let bind = planDynamicElementReceiverBind(ctx, fctx, elemAccess, expr.arguments);
  if (bind && !emitStandaloneReceiverCapture(fctx, compileExpression(ctx, fctx, elemAccess.expression), bind)) {
    bind = undefined;
  }
  if (bind) emitObjectLiteralMethodThisInstall(ctx, fctx, bind);

  const dyn = tryEmitInlineDynamicCall(ctx, fctx, expr, true);
  if (dyn === null) {
    if (bind) emitObjectLiteralMethodThisRestore(ctx, fctx, bind);
    return null;
  }
  return finishObjectLiteralMethodCall(ctx, fctx, bind, dyn);
}
