// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7214) `recv.f += rhs` where the storage slot (a struct field or a static
 * global) holds a native string.
 *
 * The property compound lowering is f64-based: it coerced the string field to a
 * number, `f64.add`-ed, and the f64 → native-string writeback has no arm, so it
 * stored `ref.null` — the next read of the field trapped with "dereferencing a
 * null pointer" (or "illegal cast" when the null reached a cast). A string slot
 * makes `+=` a concatenation whatever the RHS is (§13.15.2 → §13.15.3 step 3:
 * ToPrimitive(lval) is a string), so the gate is the slot's ValType alone.
 *
 * Both operands are coerced exactly as `recv.f + rhs` coerces them (the
 * native-strings `+` operand cascade), so `recv.f += rhs` and
 * `recv.f = recv.f + rhs` agree — with the receiver evaluated once.
 */
import type { ValType } from "../../ir/types.js";
import { ts } from "../../ts-api.js";
import { allocTempLocal, releaseTempLocal } from "../context/locals.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { nativeStringLiteralInstrs } from "../native-string-literals.js";
import { nativeStringType } from "../native-strings.js";
import { localGlobalIdx } from "../registry/imports.js";
import { compileNativeConcatOperand } from "../string-ops.js";

/** Is `slot` a native-string slot (`$AnyString` or the flat `$NativeString`)? */
function isNativeStringSlot(
  ctx: CodegenContext,
  slot: ValType,
): slot is Extract<ValType, { kind: "ref" | "ref_null" }> {
  if (slot.kind !== "ref" && slot.kind !== "ref_null") return false;
  if (!ctx.nativeStrings || ctx.anyStrTypeIdx < 0) return false;
  return slot.typeIdx === ctx.anyStrTypeIdx || slot.typeIdx === ctx.nativeStrTypeIdx;
}

/**
 * Precondition: the slot's current value is on the stack. Returns `undefined`
 * (nothing emitted) when this is not `+=` on a native-string slot; otherwise
 * concatenates, calls `store(resultTmp)` to write the slot back, and leaves the
 * result on the stack.
 */
function tryEmitNativeStringSlotAppend(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.Expression,
  rhs: ts.Expression,
  op: ts.SyntaxKind,
  slotType: ValType,
  store: (resultTmp: number) => void,
): ValType | null | undefined {
  if (op !== ts.SyntaxKind.PlusEqualsToken || !isNativeStringSlot(ctx, slotType)) return undefined;
  const concatIdx = ctx.nativeStrHelpers.get("__str_concat");
  // A flat `$NativeString` slot cannot hold the ConsString concat result.
  const flat = slotType.typeIdx === ctx.nativeStrTypeIdx && ctx.nativeStrTypeIdx !== ctx.anyStrTypeIdx;
  const flattenIdx = flat ? ctx.nativeStrHelpers.get("__str_flatten") : undefined;
  if (concatIdx === undefined || (flat && flattenIdx === undefined)) return undefined;

  // Left: the value read from the slot, coerced as the `+` operand `target`.
  // An empty slot of a field typed `T | undefined` (e.g. `f?: string`) holds
  // `undefined`, which the plain read surfaces as such — stringify it the same.
  const { nullable, undefinable } = ctx.oracle.nullabilityOf(target);
  if (slotType.kind === "ref_null" && undefinable && !nullable) {
    const slotTmp = allocTempLocal(fctx, slotType);
    fctx.body.push({ op: "local.tee", index: slotTmp }, { op: "ref.is_null" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: nativeStringType(ctx) },
      then: nativeStringLiteralInstrs(ctx, "undefined"),
      else: [{ op: "local.get", index: slotTmp }, { op: "ref.as_non_null" }],
    });
    releaseTempLocal(fctx, slotTmp);
  } else if (!compileNativeConcatOperand(ctx, fctx, target, false, slotType)) {
    return null;
  }
  // Right: compiled and coerced as the `+` operand `rhs`.
  if (!compileNativeConcatOperand(ctx, fctx, rhs)) return null;
  fctx.body.push({ op: "call", funcIdx: concatIdx });

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
  target: ts.Expression,
  rhs: ts.Expression,
  op: ts.SyntaxKind,
  fieldType: ValType,
  objTmp: number,
  typeIdx: number,
  fieldIdx: number,
): ValType | null | undefined {
  return tryEmitNativeStringSlotAppend(ctx, fctx, target, rhs, op, fieldType, (res) => {
    fctx.body.push({ op: "local.get", index: objTmp }, { op: "local.get", index: res });
    fctx.body.push({ op: "struct.set", typeIdx, fieldIdx });
  });
}

/** `C.f += rhs` on the static global `globalIdx`, whose value is on the stack. */
export function tryEmitNativeStringGlobalAppend(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.Expression,
  rhs: ts.Expression,
  op: ts.SyntaxKind,
  globalIdx: number,
): ValType | null | undefined {
  const slotType = ctx.mod.globals[localGlobalIdx(ctx, globalIdx)]?.type;
  if (!slotType) return undefined;
  return tryEmitNativeStringSlotAppend(ctx, fctx, target, rhs, op, slotType, (res) => {
    fctx.body.push({ op: "local.get", index: res }, { op: "global.set", index: globalIdx });
  });
}
