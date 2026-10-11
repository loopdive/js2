// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6771 S8/S9) Vec element fidelity across the externref boundary,
 * `--target standalone`.
 *
 * ## S8 — an `undefined` element crossing into an f64 vec stays `undefined`
 *
 * `var a = Array.from(obj)` is checker-typed `number[]`, so the declaration's
 * slot is an f64 vec and the call's externref result is materialized into it
 * element by element (`buildVecFromExternref`). Each element went through
 * `__unbox_number` — ToNumber — so an array-like's absent index
 * (`delete obj[2]`; §23.1.2.1 step 5.k.ii `Get(arrayLike, "2")` is `undefined`)
 * landed as the NUMBER NaN, and `a[2] === undefined` was false
 * (`Array/from/source-object-length.js`).
 *
 * The f64 carrier already has the answer: the `UNDEF_F64_BITS` signaling-NaN
 * payload means "this slot holds `undefined`" to the static observers (`===
 * undefined`, `typeof`, ToString) while arithmetic still sees a NaN. So an
 * `undefined` element stores that payload — the same straight-line `select` the
 * #5251 undefined-sentinel sink uses — and every other element keeps its
 * `__unbox_number` answer. (A PRESENT `undefined`, not `HOLE_F64_BITS`:
 * Array.from defines every index.) The dynamic read `__extern_get_idx` boxes an
 * f64 element through `__box_number`, which deliberately does NOT resurrect the
 * payload (#3315 — a computed NaN may carry it), so in a module that stored one
 * {@link fillVecElemGetIdxArms} answers `undefined` for an in-range element
 * holding exactly the payload, ahead of the ordinary f64 arm.
 *
 * ## S9 — a boolean vec's dynamic read answers its own element
 *
 * `boxVecElementToExternref` returns `null` for a `boolean`-branded i32
 * element (a number box would print `true` as `1`), so `fillExternGetIdxVecArms`
 * gave a `boolean[]` carrier NO arm and every dynamic read of one missed —
 * `undefined`, or under `protoIndexDirty` (where even a static `b[0]` defers to
 * `__extern_get_idx`) the prototype-index consult, which reads a setter-only
 * `Array.prototype["0"]` as `undefined` (`Array/of/does-not-use-prototype-
 * properties.js`). A dense in-range element is an OWN property (§10.4.2); the
 * arm reads it and boxes through `__box_boolean`. An out-of-range index falls
 * through to the ordinary miss. (A module holding BOTH i32 flavours keeps the
 * boolean one out of `vecTypeMap` — `disambiguateI32VecKey` — and its struct is
 * canonically the number vec's, so no `ref.test` can tell them apart; that case
 * is unchanged.)
 */
import type { Instr, ValType } from "../../ir/types.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { allocLocal } from "../context/locals.js";
import { canonicalUndefinedExternInstrs } from "../helpers/core-delegates.js"; // (#6797) late-bound core
import { ensureLateImport } from "../shared.js";
import { definedFuncAt } from "../func-space.js";
import { getArrTypeIdxFromVec } from "../registry/types.js";
import { UNDEF_F64_BITS } from "../value-tags.js";

/** Modules that stored `UNDEF_F64_BITS` into an f64 vec through {@link vecF64ElemFromExternInstrs}. */
const storesUndefElems = new WeakSet<CodegenContext>();

/** Register `__extern_is_undefined` for an f64-element vec materialization. Call BEFORE the caller's flush. */
export function prepareVecF64UndefElem(ctx: CodegenContext, elemType: ValType): void {
  if (!ctx.standalone || elemType.kind !== "f64") return;
  ensureLateImport(ctx, "__extern_is_undefined", [{ kind: "externref" }], [{ kind: "i32" }]);
}

/** externref element (on the stack) → f64 slot value: `undefined` → `UNDEF_F64_BITS`, else `__unbox_number`. */
export function vecF64ElemFromExternInstrs(ctx: CodegenContext, fctx: FunctionContext, unboxIdx: number): Instr[] {
  const isUndefIdx = ctx.standalone ? ctx.funcMap.get("__extern_is_undefined") : undefined;
  if (isUndefIdx === undefined) return [{ op: "call", funcIdx: unboxIdx }];
  storesUndefElems.add(ctx);
  const elem = allocLocal(fctx, `__vec_f64_elem_${fctx.locals.length}`, { kind: "externref" });
  return [
    { op: "local.set", index: elem },
    { op: "i64.const", value: UNDEF_F64_BITS },
    { op: "f64.reinterpret_i64" },
    { op: "local.get", index: elem },
    { op: "call", funcIdx: unboxIdx },
    { op: "local.get", index: elem },
    { op: "call", funcIdx: isUndefIdx },
    { op: "select" },
  ];
}

/**
 * `__extern_get_idx(v, idx)` arm for one vec carrier (locals: 1 = idx f64,
 * 2 = v as anyref, `iLocal` = scratch i32): for `0 <= i < length` within the
 * backing array, `onElem` receives the element on the stack and either returns
 * or leaves nothing; anything else falls through.
 */
function inRangeVecElemArm(vecTypeIdx: number, arrTypeIdx: number, iLocal: number, onElem: Instr[]): Instr[] {
  const data: Instr[] = [
    { op: "local.get", index: 2 },
    { op: "ref.cast", typeIdx: vecTypeIdx },
    { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 },
  ];
  return [
    { op: "local.get", index: 2 },
    { op: "ref.test", typeIdx: vecTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 1 },
        { op: "i32.trunc_sat_f64_s" },
        { op: "local.tee", index: iLocal },
        { op: "local.get", index: 2 },
        { op: "ref.cast", typeIdx: vecTypeIdx },
        { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 },
        { op: "i32.lt_u" }, // 0 <= i < length (a negative i wraps high)
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: iLocal },
            ...data,
            { op: "array.len" },
            { op: "i32.lt_u" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [...data, { op: "local.get", index: iLocal }, { op: "array.get", typeIdx: arrTypeIdx }, ...onElem],
            },
          ],
        },
      ],
    },
  ];
}

/**
 * Finalize fill (standalone), run right after `fillExternGetIdxVecArms` and
 * before the vec overlay prologue is spliced in front — so the overlay still
 * answers first and these arms precede the ordinary vec arms. S8: an f64
 * element holding exactly `UNDEF_F64_BITS`, in a module that stored one, reads
 * `undefined`. S9: a `boolean`-branded i32 carrier reads its element through
 * `__box_boolean`.
 */
export function fillVecElemGetIdxArms(ctx: CodegenContext): void {
  if (!ctx.standalone || !ctx.externGetIdxReserved) return;
  const funcIdx = ctx.funcMap.get("__extern_get_idx");
  const fn = funcIdx === undefined ? undefined : definedFuncAt(ctx, funcIdx);
  if (!fn || fn.body.length < 3 || fn.body[2]?.op !== "local.set") return;
  const boxBoolIdx = ctx.funcMap.get("__box_boolean");
  const iLocal = 2 + fn.locals.length;
  const arms: Instr[] = [];
  for (const vecTypeIdx of [...new Set(ctx.vecTypeMap.values())].sort((a, b) => a - b)) {
    const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
    const arrDef = arrTypeIdx < 0 ? undefined : ctx.mod.types[arrTypeIdx];
    if (arrDef?.kind !== "array") continue;
    const elem = arrDef.element;
    if (elem.kind === "f64" && storesUndefElems.has(ctx)) {
      arms.push(
        ...inRangeVecElemArm(vecTypeIdx, arrTypeIdx, iLocal, [
          { op: "i64.reinterpret_f64" },
          { op: "i64.const", value: UNDEF_F64_BITS },
          { op: "i64.eq" },
          { op: "if", blockType: { kind: "empty" }, then: [...canonicalUndefinedExternInstrs(ctx), { op: "return" }] },
        ]),
      );
    } else if (elem.kind === "i32" && (elem as { boolean?: boolean }).boolean === true && boxBoolIdx !== undefined) {
      arms.push(
        ...inRangeVecElemArm(vecTypeIdx, arrTypeIdx, iLocal, [{ op: "call", funcIdx: boxBoolIdx }, { op: "return" }]),
      );
    }
  }
  if (arms.length === 0) return;
  fn.locals.push({ name: "__vecelem_i", type: { kind: "i32" } });
  fn.body.splice(3, 0, ...arms);
}
