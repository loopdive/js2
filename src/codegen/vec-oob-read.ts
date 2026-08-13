// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { Instr } from "../ir/types.js";

/** Guard a vec read with JavaScript's out-of-bounds `undefined` semantics. */
export function guardVecElementRead(vecTypeIdx: number, elementRead: Instr[], undefinedInstrs: Instr[]): Instr[] {
  return [
    { op: "local.get", index: 1 },
    { op: "local.get", index: 2 },
    { op: "ref.cast", typeIdx: vecTypeIdx },
    { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 },
    { op: "i32.lt_u" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "externref" } },
      then: elementRead,
      else: undefinedInstrs.map((instr) => ({ ...instr })),
    },
    { op: "return" },
  ];
}
