// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * `Array.prototype.push` with a spread argument, at runtime length (#5361).
 *
 * `compileArrayPush` unrolls one `array.set` per AST argument node, which is
 * exact only while every argument is one value. A spread contributes its
 * RUNTIME element count, so `a.push(x, ...src)` stored `src` itself in one
 * slot — the array shows up nested one level down, and `a.length` is short by
 * `src.length - 1`.
 *
 * Two narrower predecessors already exist and stay in front of this one
 * (`compileArrayPushDynamicSpreadNative`/`…Host`, #2784-era): they handle the
 * single-spread call `a.push(...src)` and are tuned for it. This path covers
 * everything they decline — mixed lists, several spreads, and an inline array
 * literal source (`...["x", "y"]`), which lowers to a TUPLE struct that the
 * host arm's externref mirror reads as N null elements.
 */
import type { ts } from "../ts-api.js";
import type { Instr, ValType } from "../ir/types.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { buildSpreadArgList } from "./spread-arg-list.js";
import { compileExpression } from "./shared.js";
import { emitEnsureBackingCapacity, emitReceiverNullGuard } from "./array-methods.js";

/**
 * Append every argument value — spread sources expanded — to a native vec
 * receiver. Returns the new length (i32 in fast mode, f64 otherwise), or
 * `undefined` when the argument list could not be built (the caller keeps its
 * existing lowering).
 *
 * `a.push(...a)` is well defined here: the builder captures each spread
 * source's length and backing BEFORE the receiver's backing is grown, so the
 * appended run is the original prefix, not a live view of the array being
 * appended to.
 */
export function compileArrayPushSpread(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType | undefined {
  const recvLocal = allocLocal(fctx, `__push_sp_recv_${fctx.locals.length}`, {
    kind: "ref_null",
    typeIdx: vecTypeIdx,
  });
  const lenLocal = allocLocal(fctx, `__push_sp_len_${fctx.locals.length}`, { kind: "i32" });
  const neededLocal = allocLocal(fctx, `__push_sp_need_${fctx.locals.length}`, { kind: "i32" });
  const dataLocal = allocLocal(fctx, `__push_sp_data_${fctx.locals.length}`, {
    kind: "ref_null",
    typeIdx: arrTypeIdx,
  });
  const writeLocal = allocLocal(fctx, `__push_sp_w_${fctx.locals.length}`, { kind: "i32" });

  // Receiver first (§13.3.6.1 evaluates the member expression before the
  // arguments), then the argument list.
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: recvLocal });
  emitReceiverNullGuard(ctx, fctx, recvLocal, propAccess.expression);
  fctx.body.push({ op: "drop" });

  const built = buildSpreadArgList(ctx, fctx, callExpr.arguments, 0, elemType, "push_sp");
  if (!built) return undefined;

  fctx.body.push({ op: "local.get", index: recvLocal });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.tee", index: lenLocal });
  fctx.body.push({ op: "local.get", index: built.countLocal });
  fctx.body.push({ op: "i32.add" });
  fctx.body.push({ op: "local.set", index: neededLocal });

  fctx.body.push({ op: "local.get", index: recvLocal });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataLocal });
  emitEnsureBackingCapacity(fctx, recvLocal, dataLocal, vecTypeIdx, arrTypeIdx, neededLocal);

  fctx.body.push({ op: "local.get", index: lenLocal });
  fctx.body.push({ op: "local.set", index: writeLocal });
  const pre: Instr[] = [
    { op: "local.get", index: dataLocal },
    { op: "local.get", index: writeLocal },
  ];
  const post: Instr[] = [
    { op: "array.set", typeIdx: arrTypeIdx },
    { op: "local.get", index: writeLocal },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.set", index: writeLocal },
  ];
  built.emitStores({ pre, post });

  fctx.body.push({ op: "local.get", index: recvLocal });
  fctx.body.push({ op: "local.get", index: neededLocal });
  fctx.body.push({ op: "struct.set", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.get", index: neededLocal });
  if (!ctx.fast) fctx.body.push({ op: "f64.convert_i32_s" });
  return ctx.fast ? { kind: "i32" } : { kind: "f64" };
}
