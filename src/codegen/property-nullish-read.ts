// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { ValType } from "../ir/types.js";
import { ts } from "../ts-api.js";
import { allocTempLocal, releaseTempLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { tryEmitFnctorPrototypeRead } from "./expressions/fnctor-prototype.js";
import { ensureExternIsUndefinedImport, ensureLateImport, flushLateImportShifts } from "./expressions/late-imports.js";
import { reserveMemberGetDispatch } from "./member-get-dispatch.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { receiverIsRealmGlobalObject } from "./helpers/sloppy-this-global.js"; // (#4500 Slice A)
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
  // (#4500 Slice A) `this.p` / `globalThis.p` for a `var`-declared global has ONE
  // source of truth: the wasm module global (see `compilePropertyAccess`). This
  // path otherwise answers from the global OBJECT via a dynamic `__extern_get`,
  // which for such a name is always absent — so a nullish COMPARISON contradicted
  // the ordinary read once that read was fixed:
  //
  //   var p1 = 7;  this.p1 === 7           // true   (module global)
  //   var p1 = 7;  this.p1 === undefined   // ALSO true (this path, object)
  //
  // Both were live in one program. Delegate so the module-global arm decides.
  // (Disjoint from the #4480 fnctor arm below: this one fires only for the
  // realm-global receiver, that one only for a user-function receiver.)
  if (ctx.moduleGlobals.has(propName) && receiverIsRealmGlobalObject(ctx, fctx, expr.expression)) {
    return compilePropertyAccess(ctx, fctx, expr);
  }

  // (#4480 S1) `F.prototype === undefined` must see the auto-minted prototype
  // object. This route deliberately bypasses `property-access-dispatch.ts` and
  // reads the boxed value through `__get_member_<p>` / `__extern_get`, which for
  // a FUNCTION receiver means the closure's own-property bag — empty for a
  // `.prototype` nobody assigned. So the ONE arm that materializes §13.2's
  // automatic object never ran on this path, and `S13.2_A1_T1`'s
  // `if (__func.prototype === undefined)` kept reading `undefined` while a
  // `typeof __func.prototype` two lines away already answered `"object"`. That
  // split is measurable on this branch's own S1: it is the difference between
  // probe `e4` (only a `=== undefined` read ⇒ no `__fnctor_proto_*` global in
  // the module at all) and probe `e5` (a second, ordinary read ⇒ correct).
  //
  // Consulting the interception FIRST rather than adding an arm downstream is
  // what makes the two routes share one object: the interception is the mint
  // site, so whichever read runs first vivifies the same global.
  //
  // Skipping this route's receiver null-check is sound here and only here: the
  // arm answers only for a receiver `resolveFnctorSymbol` resolved to a user
  // function DECLARATION/expression, which is never null or undefined, so the
  // `TypeError` this path would otherwise guard is unreachable.
  {
    const fnctorProto = tryEmitFnctorPrototypeRead(ctx, fctx, expr, propName);
    if (fnctorProto !== undefined) return fnctorProto;
  }

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
