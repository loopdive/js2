// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** The concrete JS-array element carriers served by the descriptor overlay. */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { getArrTypeIdxFromVec } from "./registry/types.js";
import { HOLE_F64_BITS } from "./value-tags.js";

export interface OverlayCarrier {
  vecTypeIdx: number;
  arrTypeIdx: number;
  elemType: ValType;
  kind: "f64" | "externref" | "any" | "anystr";
}

export type CarrierDefaultMode = "default" | "undefined" | "holes";

export function allowedCarriers(ctx: CodegenContext): OverlayCarrier[] {
  const seen = new Set<number>();
  const out: OverlayCarrier[] = [];
  const addCarrier = (vecTypeIdx: number): void => {
    if (seen.has(vecTypeIdx)) return;
    seen.add(vecTypeIdx);
    const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
    if (arrTypeIdx < 0) return;
    const arrDef = ctx.mod.types[arrTypeIdx];
    if (!arrDef || arrDef.kind !== "array") return;
    const elemType = arrDef.element as ValType;
    if (elemType.kind === "f64") {
      out.push({ vecTypeIdx, arrTypeIdx, elemType, kind: "f64" });
    } else if (elemType.kind === "externref") {
      out.push({ vecTypeIdx, arrTypeIdx, elemType, kind: "externref" });
    } else if (elemType.kind === "ref" || elemType.kind === "ref_null") {
      const ti = (elemType as { typeIdx: number }).typeIdx;
      if (ti === ctx.anyValueTypeIdx) {
        out.push({ vecTypeIdx, arrTypeIdx, elemType, kind: "any" });
      } else if (ti >= 0 && (ti === ctx.anyStrTypeIdx || ti === ctx.nativeStrTypeIdx)) {
        out.push({ vecTypeIdx, arrTypeIdx, elemType, kind: "anystr" });
      }
    }
  };
  for (const vecTypeIdx of ctx.vecTypeMap.values()) addCarrier(vecTypeIdx);
  const objVec = ctx.objectRuntimeTypes;
  if (objVec) addCarrier(objVec.objVecTypeIdx);
  const regexpMatchVecTypeIdx = ctx.structMap.get("__regexp_match_vec");
  if (regexpMatchVecTypeIdx !== undefined) addCarrier(regexpMatchVecTypeIdx);
  out.sort((a, b) => a.vecTypeIdx - b.vecTypeIdx);
  return out;
}

export function carrierDefaultInstrs(
  ctx: CodegenContext,
  carrier: OverlayCarrier,
  mode: CarrierDefaultMode,
  missExtern: () => Instr[],
): Instr[] {
  if (carrier.kind === "f64") {
    return mode === "holes" && ctx.standalone && ctx.usesArrayHoles
      ? [{ op: "i64.const", value: HOLE_F64_BITS }, { op: "f64.reinterpret_i64" }]
      : [{ op: "f64.const", value: 0 }];
  }
  if (carrier.kind === "externref") return mode === "undefined" ? missExtern() : [{ op: "ref.null.extern" }];
  return carrier.kind === "any"
    ? [{ op: "ref.null", typeIdx: ctx.anyValueTypeIdx }]
    : [{ op: "ref.null", typeIdx: -15 }];
}

/**
 * (#6973 stage 2) Ordinary [[Set]] of an index that is ALREADY a backed own
 * element of an `externref` carrier with NO descriptor companion: the element
 * is an implicit `{value, w/e/c: true}` data property (§10.1.9.2 step 2), so the
 * set is a plain slot store. Routing it through `__vec_dp_value` instead
 * allocated a companion for the array, appended it to the append-only overlay
 * table, and from then on every dynamic read of every array scanned that table —
 * deltablue's `this.elms[index] = value` grew it by one array per call and the
 * run slowed linearly with elapsed reps. Caller guarantees `0 <= idx < backed
 * length` and has already run the frozen-element guard. Other carrier kinds
 * (f64 / any / string) keep the companion path: their storage is lossy for a
 * value of another kind, which is what the companion holds.
 */
export function directOwnElementStore(
  carriers: OverlayCarrier[],
  l: { any: number; comp: number; index: number; value: number },
  tail: () => Instr[],
): Instr[] {
  const arms: Instr[] = [];
  for (const c of carriers) {
    if (c.kind !== "externref") continue;
    arms.push(
      { op: "local.get", index: l.any },
      { op: "ref.test", typeIdx: c.vecTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: l.any },
          { op: "ref.cast", typeIdx: c.vecTypeIdx },
          { op: "struct.get", typeIdx: c.vecTypeIdx, fieldIdx: 1 },
          { op: "local.get", index: l.index },
          { op: "local.get", index: l.value },
          { op: "array.set", typeIdx: c.arrTypeIdx },
          ...tail(),
        ],
      },
    );
  }
  if (arms.length === 0) return [];
  return [
    { op: "local.get", index: l.comp },
    { op: "ref.is_null" },
    { op: "if", blockType: { kind: "empty" }, then: arms },
  ];
}

export function carrierRefWriteBack(
  carrier: OverlayCarrier,
  castVecAndIdx: Instr[],
  wrote: Instr[],
  elemSetIdx: number,
  anyStrTypeIdx: number,
): Instr[] {
  if (carrier.kind === "any") return [];
  if (carrier.kind !== "anystr") return [];
  return [
    { op: "local.get", index: 12 },
    { op: "ref.test", typeIdx: anyStrTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...castVecAndIdx,
        { op: "local.get", index: 12 },
        { op: "ref.cast", typeIdx: anyStrTypeIdx },
        { op: "call", funcIdx: elemSetIdx },
        ...wrote,
      ],
    },
  ];
}
