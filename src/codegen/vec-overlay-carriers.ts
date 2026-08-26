// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** The concrete JS-array element carriers served by the descriptor overlay. */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { getArrTypeIdxFromVec } from "./registry/types.js";

export interface OverlayCarrier {
  vecTypeIdx: number;
  arrTypeIdx: number;
  elemType: ValType;
  kind: "f64" | "externref" | "any" | "anystr";
}

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
  externAsUndefined: boolean,
  missExtern: () => Instr[],
): Instr[] {
  if (carrier.kind === "f64") return [{ op: "f64.const", value: 0 }];
  if (carrier.kind === "externref") return externAsUndefined ? missExtern() : [{ op: "ref.null.extern" }];
  return carrier.kind === "any"
    ? [{ op: "ref.null", typeIdx: ctx.anyValueTypeIdx }]
    : [{ op: "ref.null", typeIdx: -15 }];
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
