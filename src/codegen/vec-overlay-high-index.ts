// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Standalone descriptor-overlay helpers for the upper half of the ES array-index
// domain. The object runtime keeps a signed i32 index for property ordering, but
// an array descriptor still needs to retain both its numeric-key reachability and
// its uint32 logical length.

import type { Instr } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { canonicalNumericKeyGuard } from "./vec-index-domain.js";

/**
 * Mark a canonical numeric string as reachable through the indexed read lane.
 * When requested, also retain the legal high-index fact that the signed object
 * index parser cannot represent.
 */
export function markNumericLikeNamedKey(
  ctx: CodegenContext,
  keyLocal: number,
  scratchF64: number,
  numericFlagGlobalIdx: number,
  numToStringIdx: number,
  strFlattenIdx: number,
  strEqualsIdx: number,
  anyStrTypeIdx: number,
  highArrayIndexLocal?: number,
): Instr[] {
  const strToNumberIdx = ctx.funcMap.get("__str_to_number");
  if (strToNumberIdx === undefined) return [];
  const mark: Instr[] = [
    { op: "i32.const", value: 1 },
    { op: "global.set", index: numericFlagGlobalIdx },
  ];
  if (highArrayIndexLocal !== undefined) {
    mark.push(
      { op: "local.get", index: scratchF64 },
      { op: "f64.const", value: 2147483647 },
      { op: "f64.gt" },
      { op: "local.get", index: scratchF64 },
      { op: "f64.const", value: 4294967295 },
      { op: "f64.lt" },
      { op: "i32.and" },
      { op: "local.set", index: highArrayIndexLocal },
    );
  }
  return canonicalNumericKeyGuard(
    keyLocal,
    scratchF64,
    {
      strToNumber: strToNumberIdx,
      numberToString: numToStringIdx,
      strFlatten: strFlattenIdx,
      strEquals: strEqualsIdx,
      anyStrTypeIdx,
    },
    mark,
  );
}

/** Update a vec's uint32 logical length after a high-index descriptor define. */
export function growHighArrayIndexLength(
  vecLocal: number,
  keyNumLocal: number,
  highArrayIndexLocal: number,
  vecBaseIdx: number,
  descriptorFlagsLocal: number,
  ordinarySetFlags: number,
): Instr[] {
  return [
    { op: "local.get", index: highArrayIndexLocal },
    { op: "local.get", index: descriptorFlagsLocal },
    { op: "f64.const", value: ordinarySetFlags },
    { op: "f64.ne" },
    { op: "i32.and" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: vecLocal },
        { op: "ref.cast", typeIdx: vecBaseIdx },
        { op: "local.get", index: keyNumLocal },
        { op: "f64.const", value: 1 },
        { op: "f64.add" },
        { op: "i32.trunc_sat_f64_u" },
        { op: "struct.set", typeIdx: vecBaseIdx, fieldIdx: 0 },
      ],
    },
  ];
}
