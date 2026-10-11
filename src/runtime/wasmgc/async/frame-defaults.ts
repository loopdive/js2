// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { Instr, ValType } from "../../../wasm/model/instructions.js";

/**
 * The inert default a spill field is constructed with, by ValType (#2864 F1b).
 * Overwritten by the body's declaration on first entry into the owning state, so
 * it only has to satisfy `struct.new`'s field type.
 */
export function defaultSpillInstr(type: ValType): Instr {
  switch (type.kind) {
    case "f64":
      return { op: "f64.const", value: NaN };
    case "i32":
      return { op: "i32.const", value: 0 };
    case "i64":
      return { op: "i64.const", value: 0n };
    case "externref":
      return { op: "ref.null.extern" };
    default:
      return { op: "ref.null", typeIdx: (type as { typeIdx: number }).typeIdx };
  }
}
