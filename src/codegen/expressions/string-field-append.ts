// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7214) `recv.f += rhs` where the storage slot (a struct field or a static
 * global) holds a native string.
 *
 * The property compound lowering is f64-based: it coerced the string field to a
 * number, `f64.add`-ed, and the f64 → native-string writeback has no arm, so it
 * stored `ref.null` — the next read of the field trapped with "dereferencing a
 * null pointer" (or "illegal cast" when the null reached a cast). The `+` itself
 * is the caller-supplied `plus` (`emitNativeStringSlotPlus`, the binary
 * `string + rhs` dispatch with the left operand already read); this module owns
 * the gate, the flat-slot flatten and the single write-back. `plus` is injected
 * rather than imported so this leaf stays out of the codegen import cycle.
 */
import type { ValType } from "../../ir/types.js";
import { ts } from "../../ts-api.js";
import { allocTempLocal, releaseTempLocal } from "../context/locals.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import type { emitNativeStringSlotPlus } from "../native-addition.js";

/** The `+` of a native-string slot value already on the stack and `rhs`; leaves a `ref $AnyString`. */
export type NativeStringSlotPlus = typeof emitNativeStringSlotPlus;

/**
 * Precondition: the slot's current value is on the stack. Returns `undefined`
 * (nothing emitted) when this is not `+=` on a native-string slot; otherwise appends, calls `store(resultTmp)` to write the slot back, and
 * leaves the result on the stack.
 */
function tryEmitNativeStringSlotAppend(
  ctx: CodegenContext,
  fctx: FunctionContext,
  plus: NativeStringSlotPlus,
  target: ts.Expression,
  rhs: ts.Expression,
  op: ts.SyntaxKind,
  slotType: ValType | undefined,
  store: (resultTmp: number) => void,
): ValType | null | undefined {
  if (op !== ts.SyntaxKind.PlusEqualsToken) return undefined;
  if (slotType?.kind !== "ref" && slotType?.kind !== "ref_null") return undefined;
  if (!ctx.nativeStrings || ctx.anyStrTypeIdx < 0) return undefined;
  if (slotType.typeIdx !== ctx.anyStrTypeIdx && slotType.typeIdx !== ctx.nativeStrTypeIdx) return undefined;
  // A flat `$NativeString` slot cannot hold the ConsString concat result.
  const flat = slotType.typeIdx === ctx.nativeStrTypeIdx && ctx.nativeStrTypeIdx !== ctx.anyStrTypeIdx;
  const flattenIdx = flat ? ctx.nativeStrHelpers.get("__str_flatten") : undefined;
  if (flat && flattenIdx === undefined) return undefined;

  if (!plus(ctx, fctx, target, rhs, slotType)) return null;
  if (flattenIdx !== undefined) fctx.body.push({ op: "call", funcIdx: flattenIdx });
  const resultType: ValType = { kind: "ref", typeIdx: flat ? ctx.nativeStrTypeIdx : ctx.anyStrTypeIdx };

  const resultTmp = allocTempLocal(fctx, resultType);
  fctx.body.push({ op: "local.set", index: resultTmp });
  store(resultTmp);
  fctx.body.push({ op: "local.get", index: resultTmp });
  releaseTempLocal(fctx, resultTmp);
  return resultType;
}

/** `recv.f += rhs` on struct field `fieldIdx` of `typeIdx`; the receiver is in `objTmp`, the field value on the stack. */
export function tryEmitNativeStringFieldAppend(
  ctx: CodegenContext,
  fctx: FunctionContext,
  plus: NativeStringSlotPlus,
  target: ts.Expression,
  rhs: ts.Expression,
  op: ts.SyntaxKind,
  fieldType: ValType,
  objTmp: number,
  typeIdx: number,
  fieldIdx: number,
): ValType | null | undefined {
  return tryEmitNativeStringSlotAppend(ctx, fctx, plus, target, rhs, op, fieldType, (res) => {
    fctx.body.push({ op: "local.get", index: objTmp }, { op: "local.get", index: res });
    fctx.body.push({ op: "struct.set", typeIdx, fieldIdx });
  });
}

/** `C.f += rhs` on the static global `globalIdx` (of `slotType`), whose value is on the stack. */
export function tryEmitNativeStringGlobalAppend(
  ctx: CodegenContext,
  fctx: FunctionContext,
  plus: NativeStringSlotPlus,
  target: ts.Expression,
  rhs: ts.Expression,
  op: ts.SyntaxKind,
  globalIdx: number,
  slotType: ValType | undefined,
): ValType | null | undefined {
  return tryEmitNativeStringSlotAppend(ctx, fctx, plus, target, rhs, op, slotType, (res) => {
    fctx.body.push({ op: "local.get", index: res }, { op: "global.set", index: globalIdx });
  });
}
