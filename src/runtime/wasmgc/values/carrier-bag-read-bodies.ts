// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr, ValType } from "../../../wasm/model/instructions.js";

/** Abbreviated heap type `eq` (`closure-props.ts` uses the same encoding). */
const EQ_HEAP_TYPE = -19;
const I32: ValType = { kind: "i32" };

export interface CarrierBagMarkerLocals {
  entryLocal: number;
  bagLocal: number;
  tmpAnyLocal: number;
}

/** Test an already non-null entry against its owning bag, screening non-eq values. */
export function buildCarrierBagMarkerBody(propEntryTypeIdx: number, args: CarrierBagMarkerLocals): Instr[] {
  return [
    { op: "local.get", index: args.entryLocal },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 1 }, // value (anyref)
    { op: "local.tee", index: args.tmpAnyLocal },
    { op: "ref.test", typeIdx: EQ_HEAP_TYPE },
    {
      op: "if",
      blockType: { kind: "val", type: I32 },
      then: [
        { op: "local.get", index: args.tmpAnyLocal },
        { op: "ref.cast", typeIdx: EQ_HEAP_TYPE },
        { op: "local.get", index: args.bagLocal },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: EQ_HEAP_TYPE },
        { op: "ref.eq" },
      ],
      else: [{ op: "i32.const", value: 0 }],
    },
  ];
}

/** Already-resolved compatibility handles; lookup must not ensure/allocate a bag. */
export interface CarrierBagReadArm {
  predicate: number | undefined;
  lookup: number | undefined;
}

export interface CarrierBagOfBindings {
  objectTypeIdx: number;
  closure: CarrierBagReadArm;
  vec: CarrierBagReadArm;
  instance: CarrierBagReadArm;
  error: CarrierBagReadArm;
}

function buildBagReadArm(objectTypeIdx: number, binding: CarrierBagReadArm): Instr[] {
  const isIdx = binding.predicate;
  const lookupIdx = binding.lookup;
  if (isIdx === undefined || lookupIdx === undefined) return [];
  return [
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: isIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 0 },
        { op: "call", funcIdx: lookupIdx },
        { op: "local.tee", index: 1 },
        { op: "ref.is_null" },
        { op: "i32.eqz" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: 1 },
            { op: "any.convert_extern" },
            { op: "ref.test", typeIdx: objectTypeIdx },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [{ op: "local.get", index: 1 }, { op: "return" }],
            },
          ],
        },
        { op: "ref.null.extern" },
        { op: "return" },
      ],
    },
  ];
}

/** Undefined preserves the legacy whole-fill refusal when no complete arm exists. */
export function buildCarrierBagOfBody(bindings: CarrierBagOfBindings): Instr[] | undefined {
  const closureArm = buildBagReadArm(bindings.objectTypeIdx, bindings.closure);
  const vecArm = buildBagReadArm(bindings.objectTypeIdx, bindings.vec);
  const instanceArm = buildBagReadArm(bindings.objectTypeIdx, bindings.instance);
  const errorArm = buildBagReadArm(bindings.objectTypeIdx, bindings.error);
  if (closureArm.length === 0 && vecArm.length === 0 && instanceArm.length === 0 && errorArm.length === 0)
    return undefined;
  return [...closureArm, ...vecArm, ...instanceArm, ...errorArm, { op: "ref.null.extern" }];
}

export interface CarrierBagHasBindings {
  objectTypeIdx: number;
  bagOfIdx: number;
  objFindIdx: number;
  /** Re-read at the marker's original construction point, independently of the cached layout. */
  markerPropEntryTypeIdx: number | undefined;
}

/** The finder supplies live entries; the separate self-marker also means absent. */
export function buildCarrierBagHasBody(bindings: CarrierBagHasBindings): Instr[] {
  return [
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: bindings.bagOfIdx },
    { op: "local.tee", index: 2 },
    { op: "ref.is_null" },
    { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 0 }, { op: "return" }] },
    { op: "local.get", index: 2 },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: bindings.objectTypeIdx },
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: bindings.objFindIdx },
    { op: "local.tee", index: 3 },
    { op: "ref.is_null" },
    { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 0 }, { op: "return" }] },
    ...(bindings.markerPropEntryTypeIdx === undefined
      ? [{ op: "i32.const", value: 0 } as const]
      : buildCarrierBagMarkerBody(bindings.markerPropEntryTypeIdx, {
          entryLocal: 3,
          bagLocal: 2,
          tmpAnyLocal: 4,
        })),
    { op: "i32.eqz" },
  ];
}
