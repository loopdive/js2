// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { ITER_KIND_ARRAY_KEYS, ITER_KIND_ARRAY_ENTRIES } from "./iterator-native.js";

/** next() locals: rec=1, index=3, value=5, scratch=6. Dependencies are
 * registered by the reflective factory, before iterator finalization. */
export function buildLiveArrayIteratorValue(ctx: CodegenContext, recordType: number, getIndex: number): Instr[] {
  const box = ctx.funcMap.get("__box_number");
  const makePair = ctx.funcMap.get("__objvec_new");
  const pushPair = ctx.funcMap.get("__objvec_push");
  const index = (): Instr[] => [{ op: "local.get", index: 3 }, { op: "f64.convert_i32_s" }];
  const kind = (value: number): Instr[] => [
    { op: "local.get", index: 1 },
    { op: "struct.get", typeIdx: recordType, fieldIdx: 0 },
    { op: "i32.const", value },
    { op: "i32.eq" },
  ];
  const get: Instr[] = [
    { op: "local.get", index: 1 },
    { op: "struct.get", typeIdx: recordType, fieldIdx: 3 },
    ...index(),
    { op: "call", funcIdx: getIndex },
    { op: "local.set", index: 5 },
  ];
  if (box === undefined) return get;
  if (makePair !== undefined && pushPair !== undefined) {
    get.push(...kind(ITER_KIND_ARRAY_ENTRIES), {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "call", funcIdx: makePair },
        { op: "local.set", index: 6 },
        { op: "local.get", index: 6 },
        ...index(),
        { op: "call", funcIdx: box },
        { op: "call", funcIdx: pushPair },
        { op: "local.get", index: 6 },
        { op: "local.get", index: 5 },
        { op: "call", funcIdx: pushPair },
        { op: "local.get", index: 6 },
        { op: "local.set", index: 5 },
      ],
    });
  }
  return [
    ...kind(ITER_KIND_ARRAY_KEYS),
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [...index(), { op: "call", funcIdx: box }, { op: "local.set", index: 5 }],
      else: get,
    },
  ];
}
