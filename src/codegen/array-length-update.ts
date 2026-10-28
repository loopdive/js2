// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7164) The static Array `length` store, shared by every syntactic form that
 * writes it: `arr.length = n`, `arr.length++` / `--`, `++arr.length` /
 * `--arr.length` and `arr.length += k` / `-= k`.
 *
 * The plain assignment used to be the only form that ran the length-store fill
 * (`vec-length-hole-fill.ts`). The update forms went elsewhere: `++` / `--`
 * through the dynamic `__extern_set` arm (which fills a grow with `$Hole`) and
 * `+=` / `-=` straight to `struct.set` field 0 (which fills nothing). After a
 * shrink had written `$Hole`, a later `length++` therefore exposed the marker
 * to every dense copy (`[...g]`, `toReversed`, `Array.of(...g)`). Routing all
 * of them through one store means every grow fills `[oldLen, cap)` with the
 * canonical `undefined`, whatever form wrote it.
 */
import { ts } from "../ts-api.js";
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { buildOverlayArrayLengthSet } from "./array-filter-length-set.js";
import { emitVecLengthHoleFill } from "./vec-length-hole-fill.js";
import { emitArraySetLengthValidation } from "./array-length-define.js";
import { getArrTypeIdxFromVec, getOrRegisterVecBaseType } from "./registry/types.js";
import { compileExpression } from "./shared.js";
import { rollbackSpeculative, snapshotSpeculative } from "./context/speculative.js";

/**
 * Store `newLenTmp` (i32) into the vec parked in `vecTmp` (`$__vec_base`),
 * with the length-store fill (or the descriptor-overlay route when active).
 * `literalClear` marks a store of the literal `0`, which cannot grow: it keeps
 * the shrink-only fill and emits no grow code. When the receiver was not
 * proven a vec, `vecTmp` may be null and the store is skipped.
 */
export function emitArrayLengthStore(
  ctx: CodegenContext,
  fctx: FunctionContext,
  vecTmp: number,
  newLenTmp: number,
  target: ts.Node,
  receiverProvenVec: boolean,
  literalClear = false,
  receiverType?: ValType,
): void {
  const vecBaseIdx = getOrRegisterVecBaseType(ctx);
  const lengthStore: Instr[] = [
    { op: "local.get", index: vecTmp },
    { op: "local.get", index: newLenTmp },
    { op: "struct.set", typeIdx: vecBaseIdx, fieldIdx: 0 },
  ];
  // (#6482 r4) This store touches ONLY field 0, so the fill marks the region
  // the length change orphans (shrink) or exposes (grow) before it moves.
  // Overlay validation owns deletion when present: filling before it could
  // erase elements even when a non-writable length rejects the shrink.
  let selectedStore = buildOverlayArrayLengthSet(ctx, fctx, vecTmp, newLenTmp, target);
  if (selectedStore === null) {
    const savedBody = fctx.body;
    fctx.body = [];
    try {
      // (#7164) A shrink marks the dropped slots `$Hole`; a grow reallocates
      // when needed and fills the new slots with the canonical `undefined`.
      const canGrow = !literalClear && receiverMayHoldExternref(ctx, receiverType);
      emitVecLengthHoleFill(ctx, fctx, vecTmp, newLenTmp, canGrow ? "length-store" : "shrink-only", true);
      selectedStore = [...fctx.body, ...lengthStore];
    } finally {
      fctx.body = savedBody;
    }
  }
  if (receiverProvenVec) {
    for (const instr of selectedStore) fctx.body.push(instr);
  } else {
    // The guarded cast parks `null` when the receiver was not a vec.
    fctx.body.push({ op: "local.get", index: vecTmp });
    fctx.body.push({ op: "ref.is_null" });
    fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: [], else: selectedStore });
  }
}

/**
 * Only the externref carrier gets grow code. A receiver compiled as a typed vec
 * of another element kind skips it (the same bytes as before #7164); an
 * unknown or externref receiver keeps it.
 */
function receiverMayHoldExternref(ctx: CodegenContext, receiverType: ValType | undefined): boolean {
  if (!receiverType || (receiverType.kind !== "ref" && receiverType.kind !== "ref_null")) return true;
  const arrTypeIdx = getArrTypeIdxFromVec(ctx, receiverType.typeIdx);
  const arrDef = arrTypeIdx < 0 ? undefined : ctx.mod.types[arrTypeIdx];
  return arrDef?.kind !== "array" || arrDef.element.kind === "externref";
}

/** The forms {@link tryCompileArrayLengthUpdate} lowers. */
export type ArrayLengthUpdate =
  | { kind: "step"; delta: 1 | -1; postfix: boolean }
  | { kind: "compound"; op: "+" | "-"; value: ts.Expression };

/**
 * `arr.length++` / `--` / `+= k` / `-= k` on a receiver statically typed as an
 * Array whose value is a vec: read the length, compute ToUint32-validated new
 * length, and store it through {@link emitArrayLengthStore}. Returns
 * `undefined` (nothing emitted) for any other receiver or a non-numeric `k`,
 * which keep their existing lowering.
 */
export function tryCompileArrayLengthUpdate(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.Expression,
  update: ArrayLengthUpdate,
): ValType | undefined {
  if (!ts.isPropertyAccessExpression(target) || target.name.text !== "length") return undefined;
  if (ctx.oracle.typeFactOf(target.expression).kind !== "array") return undefined;
  if (update.kind === "compound" && ctx.oracle.staticJsTypeOf(update.value) !== "number") return undefined;
  const snap = snapshotSpeculative(ctx, fctx);
  const receiver = compileExpression(ctx, fctx, target.expression);
  // Only a receiver proven to be a vec: anything else keeps its existing route.
  if (
    !receiver ||
    (receiver.kind !== "ref" && receiver.kind !== "ref_null") ||
    getArrTypeIdxFromVec(ctx, receiver.typeIdx) < 0
  ) {
    rollbackSpeculative(ctx, fctx, snap);
    return undefined;
  }
  const vecBaseIdx = getOrRegisterVecBaseType(ctx);
  const vecTmp = allocLocal(fctx, `__arr_len_upd_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecBaseIdx });
  const oldTmp = allocLocal(fctx, `__arr_len_upd_old_${fctx.locals.length}`, { kind: "f64" });
  const newLenTmp = allocLocal(fctx, `__arr_len_upd_new_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.tee", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecBaseIdx, fieldIdx: 0 });
  fctx.body.push({ op: "f64.convert_i32_u" });
  fctx.body.push({ op: "local.tee", index: oldTmp });
  if (update.kind === "step") {
    fctx.body.push({ op: "f64.const", value: 1 });
    fctx.body.push({ op: update.delta === 1 ? "f64.add" : "f64.sub" });
  } else {
    const valueType = compileExpression(ctx, fctx, update.value, { kind: "f64" });
    if (valueType?.kind === "i32") fctx.body.push({ op: "f64.convert_i32_s" });
    else if (valueType?.kind !== "f64") {
      rollbackSpeculative(ctx, fctx, snap);
      return undefined;
    }
    fctx.body.push({ op: update.op === "+" ? "f64.add" : "f64.sub" });
  }
  // §10.4.2.4 step 3: RangeError unless the new length is a uint32.
  emitArraySetLengthValidation(ctx, fctx);
  fctx.body.push({ op: "local.set", index: newLenTmp });
  emitArrayLengthStore(ctx, fctx, vecTmp, newLenTmp, target, true, false, receiver);
  // Result: the old value for a postfix update, the new length otherwise.
  if (update.kind === "step" && update.postfix) {
    fctx.body.push({ op: "local.get", index: oldTmp });
  } else {
    fctx.body.push({ op: "local.get", index: newLenTmp });
    fctx.body.push({ op: "f64.convert_i32_u" });
  }
  return { kind: "f64" };
}
