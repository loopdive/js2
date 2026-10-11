// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6641) Generic `__extern_method_call` dispatch for a COMPUTED-key method
 * call (`recv[k](...)`) on a receiver whose static type is `any`/externref —
 * the bracket twin of the `(#799 WI3)` dot-access arm in
 * `call-receiver-method.ts`.
 *
 * That literal-key arm is what makes `api.add(3, 4)` answer correctly for a
 * cross-module linked-provider receiver under `--target standalone`: nothing
 * about the receiver's TS type is known (it crossed a `field(): any` getter),
 * so every specific arm declines and this generic one calls
 * `__extern_method_call(recv, name, args)` with a STRING-CONSTANT name.
 *
 * The computed-key call site (`call-tail-dispatch.ts`) has arms for a
 * user-class receiver, a TS-known plain-object-literal receiver, and (JS-host
 * only) `tryEmitDynamicElementHostMethodCall` — but no arm for the same
 * `any`/externref case the literal path covers. `noJsHost(ctx)` (standalone /
 * wasi) is exactly where the host-bridge arm bails, so a linked-provider
 * receiver fell through every arm to the silent "drop everything, return
 * null" fallback: `api[k](3, 4)` answered `null` while `api.add(3, 4)`
 * answered `7`. This arm closes that gap by computing the NAME at runtime
 * (`elemAccess.argumentExpression` compiled to externref, the same key
 * marshaling the element-access READ path already uses successfully — see
 * `compileElementAccessBody`'s generic `__extern_get(recv, key)` arm) instead
 * of a string constant.
 */
import type { ts } from "../../ts-api.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import type { InnerResult } from "../shared.js";
import { coerceType, compileExpression } from "../shared.js";
import { ensureObjVecBuilders } from "../object-runtime.js";
import { emitHostMethodCallArgs } from "../host-method-args.js";
import { noJsHost } from "../js-errors.js";
import { allocLocal } from "../context/locals.js";
import { ensureLateImport, flushLateImportShifts } from "./late-imports.js";

/**
 * Standalone/wasi twin of `tryEmitDynamicElementHostMethodCall`: dispatch a
 * computed-key method call through the generic `__extern_method_call` native,
 * with the method name computed at runtime instead of a string constant.
 * Returns `undefined` when this arm does not apply (JS-host lane, where the
 * host-bridge arm already covers this shape; or the native helpers are
 * unavailable), letting the caller fall through to its next arm unchanged.
 */
export function tryEmitGenericComputedMethodCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  elemAccess: ts.ElementAccessExpression,
): InnerResult | undefined {
  if (
    !noJsHost(ctx) ||
    elemAccess.argumentExpression === undefined ||
    expr.arguments.some((arg) => arg === undefined)
  ) {
    return undefined;
  }
  const externref = { kind: "externref" as const };
  const { newIdx: arrNewIdx, pushIdx: arrPushIdx } = ensureObjVecBuilders(ctx);
  const methodCallIdx = ensureLateImport(ctx, "__extern_method_call", [externref, externref, externref], [externref]);
  flushLateImportShifts(ctx, fctx);
  if (methodCallIdx === undefined) return undefined;

  const recvType = compileExpression(ctx, fctx, elemAccess.expression, externref);
  if (recvType === null) fctx.body.push({ op: "ref.null.extern" });
  else if (recvType.kind !== "externref") coerceType(ctx, fctx, recvType, externref);
  const recvLocal = allocLocal(fctx, `__gcm_recv_${fctx.locals.length}`, externref);
  fctx.body.push({ op: "local.set", index: recvLocal });

  const keyType = compileExpression(ctx, fctx, elemAccess.argumentExpression, externref);
  if (keyType === null) fctx.body.push({ op: "ref.null.extern" });
  else if (keyType.kind !== "externref") coerceType(ctx, fctx, keyType, externref);
  const keyLocal = allocLocal(fctx, `__gcm_key_${fctx.locals.length}`, externref);
  fctx.body.push({ op: "local.set", index: keyLocal });

  fctx.body.push({ op: "call", funcIdx: arrNewIdx });
  const argsLocal = allocLocal(fctx, `__gcm_args_${fctx.locals.length}`, externref);
  fctx.body.push({ op: "local.set", index: argsLocal });
  emitHostMethodCallArgs(ctx, fctx, expr, argsLocal, "__objvec_push", arrPushIdx);

  fctx.body.push({ op: "local.get", index: recvLocal });
  fctx.body.push({ op: "local.get", index: keyLocal });
  fctx.body.push({ op: "local.get", index: argsLocal });
  fctx.body.push({ op: "call", funcIdx: methodCallIdx });
  return externref;
}
