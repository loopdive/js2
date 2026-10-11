// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr } from "../../ir/types.js";

/** A non-extensible native carrier may only keep its current prototype. */
export function closedCarrierPrototypeStatus(
  objectTypeIdx: number,
  nonExtensibleFlag: number,
  bagLookupIdx: number | undefined,
  getPrototypeIdx: number | undefined,
): Instr[] {
  if (bagLookupIdx === undefined || getPrototypeIdx === undefined) return [];
  const EQ = -19;
  // Caller frame: 2 is an Object scratch, 5 anyref, 6 current prototype,
  // 7 proposed prototype as anyref. Lookup is intentionally allocation-free.
  return [
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: bagLookupIdx },
    { op: "any.convert_extern" },
    { op: "local.tee", index: 5 },
    { op: "ref.test", typeIdx: objectTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 5 },
        { op: "ref.cast", typeIdx: objectTypeIdx },
        { op: "local.tee", index: 2 },
        { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 4 },
        { op: "i32.const", value: nonExtensibleFlag },
        { op: "i32.and" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: 0 },
            { op: "call", funcIdx: getPrototypeIdx },
            { op: "local.tee", index: 6 },
            { op: "ref.is_null" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [{ op: "local.get", index: 1 }, { op: "ref.is_null" }, { op: "return" }],
            },
            { op: "local.get", index: 6 },
            { op: "any.convert_extern" },
            { op: "local.tee", index: 5 },
            { op: "ref.test", typeIdx: EQ },
            { op: "local.get", index: 1 },
            { op: "any.convert_extern" },
            { op: "local.tee", index: 7 },
            { op: "ref.test", typeIdx: EQ },
            { op: "i32.and" },
            {
              op: "if",
              blockType: { kind: "val", type: { kind: "i32" } },
              then: [
                { op: "local.get", index: 5 },
                { op: "ref.cast", typeIdx: EQ },
                { op: "local.get", index: 7 },
                { op: "ref.cast", typeIdx: EQ },
                { op: "ref.eq" },
              ],
              else: [{ op: "i32.const", value: 0 }],
            },
            { op: "return" },
          ],
        },
      ],
    },
  ];
}
