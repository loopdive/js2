// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr, LocalDef } from "../../../wasm/model/instructions.js";

/** ToString for exactly the unsigned integer domain used by virtual String keys. */
export function buildStringIndexKeyDefinition(
  flatType: number,
  dataType: number,
): {
  locals: LocalDef[];
  body: Instr[];
} {
  if (![flatType, dataType].every((v) => Number.isInteger(v) && v >= 0 && v <= 0xffffffff))
    throw Error("String index key: invalid physical types");
  const get = (index: number): Instr => ({ op: "local.get", index });
  const set = (index: number): Instr => ({ op: "local.set", index });
  const n = (value: number): Instr => ({ op: "i32.const", value });
  return {
    locals: [
      ...["remaining", "digits", "cursor"].map((name): LocalDef => ({ name, type: { kind: "i32" } })),
      { name: "data", type: { kind: "ref", typeIdx: dataType } },
    ],
    body: [
      get(0),
      set(1),
      n(0),
      set(2),
      {
        op: "loop",
        blockType: { kind: "empty" },
        body: [
          get(2),
          n(1),
          { op: "i32.add" },
          set(2),
          get(1),
          n(10),
          { op: "i32.div_u" },
          { op: "local.tee", index: 1 },
          { op: "br_if", depth: 0 },
        ],
      },
      get(2),
      { op: "array.new_default", typeIdx: dataType },
      set(4),
      get(0),
      set(1),
      get(2),
      set(3),
      {
        op: "loop",
        blockType: { kind: "empty" },
        body: [
          get(3),
          n(1),
          { op: "i32.sub" },
          set(3),
          get(4),
          get(3),
          get(1),
          n(10),
          { op: "i32.rem_u" },
          n(48),
          { op: "i32.add" },
          { op: "array.set", typeIdx: dataType },
          get(1),
          n(10),
          { op: "i32.div_u" },
          set(1),
          get(3),
          { op: "br_if", depth: 0 },
        ],
      },
      get(2),
      n(0),
      get(4),
      { op: "struct.new", typeIdx: flatType },
      { op: "extern.convert_any" },
    ],
  };
}
