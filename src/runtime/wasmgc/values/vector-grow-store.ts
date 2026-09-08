// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { Instr, LocalDef, ValType } from "../../../wasm/model/instructions.js";
import type { ArrayTypeDef, StructTypeDef } from "../../../wasm/model/module-records.js";

/** Closed legacy gap initialization choices; no allocating context or callbacks. */
export type VectorGrowStoreGapFill =
  | { readonly kind: "default" }
  | { readonly kind: "hole-global"; readonly globalIndex: number }
  | { readonly kind: "f64-hole"; readonly bits: bigint };

export interface VectorGrowStoreResources {
  readonly carrierTypeIndex: number;
  readonly arrayTypeIndex: number;
  readonly exceptionTagIndex: number;
  readonly gapFill: VectorGrowStoreGapFill;
}

function gapFillInstructions(fill: VectorGrowStoreGapFill): Instr[] {
  switch (fill.kind) {
    case "default":
      return [];
    case "hole-global":
      return [{ op: "global.get", index: fill.globalIndex }, { op: "extern.convert_any" }];
    case "f64-hole":
      return [{ op: "i64.const", value: fill.bits }, { op: "f64.reinterpret_i64" }];
    default:
      throw new Error("unknown vector grow/store gap fill");
  }
}

/** Exact existing grow/copy/store sequence; allocation and publication stay with the caller. */
export function buildVectorGrowStoreBody(resources: VectorGrowStoreResources): { locals: LocalDef[]; body: Instr[] } {
  const {
    carrierTypeIndex: carrierTypeIdx,
    arrayTypeIndex: arrTypeIdx,
    exceptionTagIndex: tagIdx,
    gapFill,
  } = resources;
  const hasGapFill = gapFill.kind !== "default";
  const gapFillInit = gapFillInstructions(gapFill);
  // Params: 0=vec, 1=idx, 2=val. Locals: 3=data, 4=newCap, 5=newData, 6=oldCap.
  const VEC = 0;
  const IDX = 1;
  const VAL = 2;
  const DATA = 3;
  const NCAP = 4;
  const NDATA = 5;
  const OCAP = 6;
  const OLEN = 7;

  const body: Instr[] = [
    // ── Null guard (#441 parity): if (vec == null) throw TypeError ─────────
    { op: "local.get", index: VEC },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "ref.null.extern" }, { op: "throw", tagIdx }],
      else: [],
    },
    // ── data = vec.data ─────────────────────────────────────────────────────
    { op: "local.get", index: VEC },
    { op: "struct.get", typeIdx: carrierTypeIdx, fieldIdx: 1 },
    { op: "local.set", index: DATA },
    // ── Grow when idx >= capacity (legacy sequence) ─────────────────────────
    { op: "local.get", index: IDX },
    { op: "local.get", index: DATA },
    { op: "array.len" },
    { op: "i32.ge_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        // oldCap = array.len(data)
        { op: "local.get", index: DATA },
        { op: "array.len" },
        { op: "local.set", index: OCAP },
        // newCap = idx + 1
        { op: "local.get", index: IDX },
        { op: "i32.const", value: 1 },
        { op: "i32.add" },
        { op: "local.set", index: NCAP },
        // if (oldCap * 2 > newCap) newCap = oldCap * 2
        { op: "local.get", index: OCAP },
        { op: "i32.const", value: 1 },
        { op: "i32.shl" },
        { op: "local.get", index: NCAP },
        { op: "i32.gt_s" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: OCAP },
            { op: "i32.const", value: 1 },
            { op: "i32.shl" },
            { op: "local.set", index: NCAP },
          ],
        },
        // if (4 > newCap) newCap = 4
        { op: "i32.const", value: 4 },
        { op: "local.get", index: NCAP },
        { op: "i32.gt_s" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "i32.const", value: 4 },
            { op: "local.set", index: NCAP },
          ],
        },
        // Branded externref sparse carriers and standalone f64 sparse carriers
        // fill new capacity with their respective absence markers. Dense
        // carriers retain the ordinary zero/null default.
        ...gapFillInit,
        { op: "local.get", index: NCAP },
        ...(hasGapFill
          ? ([{ op: "array.new", typeIdx: arrTypeIdx }] satisfies Instr[])
          : ([{ op: "array.new_default", typeIdx: arrTypeIdx }] satisfies Instr[])),
        { op: "local.set", index: NDATA },
        // array.copy newData[0..oldCap] = data[0..oldCap]
        { op: "local.get", index: NDATA },
        { op: "i32.const", value: 0 },
        { op: "local.get", index: DATA },
        { op: "i32.const", value: 0 },
        { op: "local.get", index: OCAP },
        { op: "array.copy", dstTypeIdx: arrTypeIdx, srcTypeIdx: arrTypeIdx },
        // vec.data = newData
        { op: "local.get", index: VEC },
        { op: "local.get", index: NDATA },
        { op: "ref.as_non_null" },
        { op: "struct.set", typeIdx: carrierTypeIdx, fieldIdx: 1 },
        // data = newData
        { op: "local.get", index: NDATA },
        { op: "local.set", index: DATA },
      ],
    },
    ...(hasGapFill
      ? ([
          // A write beyond logical length can land in already-allocated spare
          // capacity. Preserve absence in the full [oldLength, idx) gap for
          // both branded externref and standalone f64 sparse carriers.
          { op: "local.get", index: VEC },
          { op: "struct.get", typeIdx: carrierTypeIdx, fieldIdx: 0 },
          { op: "local.set", index: OLEN },
          { op: "local.get", index: IDX },
          { op: "local.get", index: OLEN },
          { op: "i32.gt_u" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: DATA },
              { op: "local.get", index: OLEN },
              ...gapFillInit,
              { op: "local.get", index: IDX },
              { op: "local.get", index: OLEN },
              { op: "i32.sub" },
              { op: "array.fill", typeIdx: arrTypeIdx },
            ],
          },
        ] satisfies Instr[])
      : []),
    // ── data[idx] = val ─────────────────────────────────────────────────────
    { op: "local.get", index: DATA },
    { op: "local.get", index: IDX },
    { op: "local.get", index: VAL },
    { op: "array.set", typeIdx: arrTypeIdx },
    // ── if (idx + 1 > vec.length) vec.length = idx + 1 ─────────────────────
    { op: "local.get", index: IDX },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.get", index: VEC },
    { op: "struct.get", typeIdx: carrierTypeIdx, fieldIdx: 0 },
    { op: "i32.gt_u" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: VEC },
        { op: "local.get", index: IDX },
        { op: "i32.const", value: 1 },
        { op: "i32.add" },
        { op: "struct.set", typeIdx: carrierTypeIdx, fieldIdx: 0 },
      ],
    },
  ];

  return {
    locals: [
      { name: "$data", type: { kind: "ref_null", typeIdx: arrTypeIdx } },
      { name: "$ncap", type: { kind: "i32" } },
      { name: "$ndata", type: { kind: "ref_null", typeIdx: arrTypeIdx } },
      { name: "$ocap", type: { kind: "i32" } },
      ...(hasGapFill ? [{ name: "$oldlen", type: { kind: "i32" } as ValType }] : []),
    ],
    body,
  };
}

/** Shared open length-prefix carrier; never register or cache from this constructor. */
export function createVectorBaseType(): StructTypeDef {
  return {
    kind: "struct",
    name: "__vec_base",
    superTypeIdx: -1, // open / non-final — concrete vecs subtype this
    fields: [{ name: "length", type: { kind: "i32" }, mutable: true }],
  };
}

/** The legacy registry resolves reference nullability before passing the element type. */
export function createVectorBackingArrayType(name: string, element: ValType): ArrayTypeDef {
  return { kind: "array", name, element, mutable: true };
}

export interface VectorCarrierTypeResources {
  readonly name: string;
  readonly baseTypeIndex: number;
  readonly arrayTypeIndex: number;
  readonly final?: boolean;
}

/** Exact field order, mutability, supertype and optional-final metadata shared by both callers. */
export function createVectorCarrierType(resources: VectorCarrierTypeResources): StructTypeDef {
  return {
    kind: "struct",
    name: resources.name,
    superTypeIdx: resources.baseTypeIndex,
    ...(resources.final === undefined ? {} : { final: resources.final }),
    fields: [
      { name: "length", type: { kind: "i32" }, mutable: true },
      { name: "data", type: { kind: "ref", typeIdx: resources.arrayTypeIndex }, mutable: true },
    ],
  };
}
