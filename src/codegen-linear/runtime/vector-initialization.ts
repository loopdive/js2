// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr } from "../../wasm/model/instructions.js";
import { LINEAR_VECTOR_ELEMENTS_OFFSET } from "../../shared/contracts/linear-memory-layout.js";

/** Fresh value-first `(f64 value, i32 pointer, i32 index) -> void` store body. */
export function buildLinearF64VectorInitializationBody(): Instr[] {
  return [
    { op: "local.get", index: 1 },
    { op: "local.get", index: 2 },
    { op: "i32.const", value: 8 },
    { op: "i32.mul" },
    { op: "i32.add" },
    { op: "local.get", index: 0 },
    { op: "f64.store", align: 3, offset: LINEAR_VECTOR_ELEMENTS_OFFSET },
  ];
}
