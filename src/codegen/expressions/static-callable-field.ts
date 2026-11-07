// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../../ts-api.js";
import { allocLocal } from "../context/locals.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { ensureObjVecBuilders, reserveApplyClosure } from "../object-runtime.js";
import { coerceType, compileExpression } from "../shared.js";
import { flushLateImportShifts } from "./late-imports.js";

/** Compile a call through a callable static field on a class-expression value. */
export function tryCompileCallableStaticField(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
  fullName: string,
): boolean {
  if (!ctx.staticProps.has(fullName) || ctx.staticMethodSet.has(fullName)) return false;
  if (ctx.oracle.signatureOf(propAccess) === undefined) return false;

  const applyIdx = reserveApplyClosure(ctx);
  const vecBuilders = ensureObjVecBuilders(ctx);
  flushLateImportShifts(ctx, fctx);
  const invokeIdx = ctx.funcMap.get("__apply_closure") ?? applyIdx;
  if (invokeIdx === undefined || vecBuilders === undefined) return false;

  const recvLocal = allocLocal(fctx, `__static_field_recv_${fctx.locals.length}`, { kind: "externref" });
  const recvType = compileExpression(ctx, fctx, propAccess.expression, { kind: "externref" });
  if (recvType === null) fctx.body.push({ op: "ref.null.extern" });
  else if (recvType.kind !== "externref") coerceType(ctx, fctx, recvType, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: recvLocal });

  const fnLocal = allocLocal(fctx, `__static_field_fn_${fctx.locals.length}`, { kind: "externref" });
  const staticGlobalIdx = ctx.staticProps.get(fullName);
  if (staticGlobalIdx === undefined) return false;
  fctx.body.push({ op: "global.get", index: staticGlobalIdx }, { op: "local.set", index: fnLocal });

  const argsLocal = allocLocal(fctx, `__static_field_args_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__objvec_new") ?? vecBuilders!.newIdx });
  fctx.body.push({ op: "local.set", index: argsLocal });
  for (const arg of expr.arguments) {
    fctx.body.push({ op: "local.get", index: argsLocal });
    emitExternrefArgument(ctx, fctx, arg);
    fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__objvec_push") ?? vecBuilders!.pushIdx });
  }
  fctx.body.push(
    { op: "local.get", index: fnLocal },
    { op: "local.get", index: recvLocal },
    { op: "local.get", index: argsLocal },
  );
  fctx.body.push({ op: "call", funcIdx: invokeIdx });
  return true;
}

function emitExternrefArgument(ctx: CodegenContext, fctx: FunctionContext, arg: ts.Expression): void {
  const argType = compileExpression(ctx, fctx, arg, { kind: "externref" });
  if (argType === null) fctx.body.push({ op: "ref.null.extern" });
  else if (argType.kind !== "externref") coerceType(ctx, fctx, argType, { kind: "externref" });
}
