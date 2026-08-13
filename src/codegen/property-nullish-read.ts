// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { ValType } from "../ir/types.js";
import { ts } from "../ts-api.js";
import { allocTempLocal, releaseTempLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { ensureExternIsUndefinedImport, ensureLateImport, flushLateImportShifts } from "./expressions/late-imports.js";
import { reserveMemberGetDispatch } from "./member-get-dispatch.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { compilePropertyAccess, typeErrorThrowInstrs } from "./property-access.js";
import { coerceType, compileExpression } from "./shared.js";

function readsCallerFromArgumentsCallee(expr: ts.PropertyAccessExpression): boolean {
  const receiver = expr.expression;
  return (
    expr.name.text === "caller" &&
    ts.isPropertyAccessExpression(receiver) &&
    receiver.name.text === "callee" &&
    ts.isIdentifier(receiver.expression) &&
    receiver.expression.text === "arguments"
  );
}

/** Read a property as its boxed JavaScript value for a nullish comparison. */
export function compilePropertyAccessForNullishObservation(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
): ValType | null {
  if (expr.questionDotToken) return compilePropertyAccess(ctx, fctx, expr);
  const externref: ValType = { kind: "externref" };
  const propName = ts.isPrivateIdentifier(expr.name) ? "__priv_" + expr.name.text.slice(1) : expr.name.text;
  const getMemberIdx = reserveMemberGetDispatch(ctx, propName, fctx);
  const getIdx =
    getMemberIdx === undefined ? ensureLateImport(ctx, "__extern_get", [externref, externref], [externref]) : undefined;
  const isUndefinedIdx = ensureExternIsUndefinedImport(ctx);
  flushLateImportShifts(ctx, fctx);

  const recvType = compileExpression(ctx, fctx, expr.expression);
  if (!recvType) fctx.body.push({ op: "ref.null.extern" });
  else if (recvType.kind !== "externref") coerceType(ctx, fctx, recvType, externref);
  const recvLocal = allocTempLocal(fctx, externref);
  fctx.body.push({ op: "local.tee", index: recvLocal }, { op: "ref.is_null" });
  if (isUndefinedIdx !== undefined) {
    fctx.body.push({ op: "local.get", index: recvLocal }, { op: "call", funcIdx: isUndefinedIdx }, { op: "i32.or" });
  }
  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: typeErrorThrowInstrs(ctx, expr), else: [] });
  fctx.body.push({ op: "local.get", index: recvLocal });
  releaseTempLocal(fctx, recvLocal);
  if (getMemberIdx !== undefined) {
    fctx.body.push({ op: "call", funcIdx: getMemberIdx });
  } else if (getIdx !== undefined) {
    fctx.body.push(...stringConstantExternrefInstrs(ctx, propName), { op: "call", funcIdx: getIdx });
  } else {
    fctx.body.push({ op: "drop" }, { op: "ref.null.extern" });
  }
  return externref;
}

/** Preserve runtime null/undefined for member reads even when static field facts are narrower. */
export function compileNullishObservedExpression(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.Expression,
): ValType | null {
  // Modules that use `delete` must retain the ordinary property route so a
  // receiver's deletion tombstone is observed before its static backing field.
  // The boxed observation route intentionally bypasses that representation for
  // collision-safe dynamic reads and would otherwise resurrect deleted values.
  const preserveMissingHostArgumentsCallee =
    !ctx.standalone && !ctx.wasi && ts.isPropertyAccessExpression(expr) && readsCallerFromArgumentsCallee(expr);
  if (ts.isPropertyAccessExpression(expr) && !ctx.moduleUsesDelete && !preserveMissingHostArgumentsCallee) {
    return compilePropertyAccessForNullishObservation(ctx, fctx, expr);
  }
  return compileExpression(ctx, fctx, expr, ts.isElementAccessExpression(expr) ? { kind: "externref" } : undefined);
}
