// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../../ts-api.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { allocLocal } from "../context/locals.js";
import { ensureObjVecBuilders, reserveApplyClosure } from "../object-runtime.js";
import type { InnerResult } from "../shared.js";
import { coerceType, compileExpression, resolveComputedKeyExpression } from "../shared.js";
import { linkSymbolWrapperPrototype } from "./calls-guards.js";
import { ensureLateImport, flushLateImportShifts } from "./late-imports.js";

/**
 * (#6775 S5) `recv[Symbol.toPrimitive](…)`, host-free. The TS lib types the
 * method as `(hint: string) => …`, so the typed-closure dispatch below padded
 * an omitted `hint` with a NON-NULL string ref (`ref.null; ref.as_non_null` —
 * a trap), and a symbol or Symbol-wrapper receiver never reached
 * `Symbol.prototype[@@toPrimitive]`. §13.3.6.1: read the method off the
 * receiver (`GetValue`, walking its prototype), then call it with the
 * receiver as `this` through the open-`any` apply bridge.
 */
export function tryEmitDynamicToPrimitiveMethodCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  elemAccess: ts.ElementAccessExpression,
): InnerResult | undefined {
  if (!ctx.standalone) return undefined;
  if (resolveComputedKeyExpression(ctx, elemAccess.argumentExpression) !== "@@toPrimitive") return undefined;
  if (expr.questionDotToken !== undefined || elemAccess.questionDotToken !== undefined) return undefined;
  if (expr.arguments.some((a) => ts.isSpreadElement(a))) return undefined;
  ensureLateImport(ctx, "__extern_get", [{ kind: "externref" }, { kind: "externref" }], [{ kind: "externref" }]);
  const symbolRecv = ctx.oracle.typeFactOf(elemAccess.expression).kind === "symbol";
  if (symbolRecv) ensureLateImport(ctx, "__new_Symbol", [{ kind: "externref" }], [{ kind: "externref" }]);
  const applyIdx = reserveApplyClosure(ctx);
  const { newIdx, pushIdx } = ensureObjVecBuilders(ctx);
  flushLateImportShifts(ctx, fctx);
  const boxSymbolIdx = ctx.funcMap.get("__box_symbol");
  const externGetIdx = ctx.funcMap.get("__extern_get");
  if (boxSymbolIdx === undefined || externGetIdx === undefined || newIdx === undefined || pushIdx === undefined) {
    return undefined;
  }
  const recvType = compileExpression(ctx, fctx, elemAccess.expression, { kind: "externref" });
  if (recvType === null) fctx.body.push({ op: "ref.null.extern" });
  else if (recvType.kind !== "externref") coerceType(ctx, fctx, recvType, { kind: "externref" });
  const recvLocal = allocLocal(fctx, `__toprim_recv_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: recvLocal });
  const fnLocal = allocLocal(fctx, `__toprim_fn_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.get", index: recvLocal });
  // A primitive Symbol receiver looks the method up on its ToObject wrapper
  // (§7.3.2 GetV); `this` stays the primitive.
  const newSymbolIdx = symbolRecv ? ctx.funcMap.get("__new_Symbol") : undefined;
  if (newSymbolIdx !== undefined) {
    fctx.body.push({ op: "call", funcIdx: newSymbolIdx });
    linkSymbolWrapperPrototype(ctx, fctx);
  }
  fctx.body.push(
    { op: "i32.const", value: 3 }, // well-known Symbol.toPrimitive
    { op: "call", funcIdx: ctx.funcMap.get("__box_symbol") ?? boxSymbolIdx },
    { op: "call", funcIdx: ctx.funcMap.get("__extern_get") ?? externGetIdx },
    { op: "local.set", index: fnLocal },
  );
  const vecLocal = allocLocal(fctx, `__toprim_args_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__objvec_new") ?? newIdx });
  fctx.body.push({ op: "local.set", index: vecLocal });
  for (const arg of expr.arguments) {
    fctx.body.push({ op: "local.get", index: vecLocal });
    const t = compileExpression(ctx, fctx, arg, { kind: "externref" });
    if (t === null) fctx.body.push({ op: "ref.null.extern" });
    else if (t.kind !== "externref") coerceType(ctx, fctx, t, { kind: "externref" });
    fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__objvec_push") ?? pushIdx });
  }
  fctx.body.push(
    { op: "local.get", index: fnLocal },
    { op: "local.get", index: recvLocal },
    { op: "local.get", index: vecLocal },
    { op: "call", funcIdx: ctx.funcMap.get("__apply_closure") ?? applyIdx },
  );
  return { kind: "externref" };
}
