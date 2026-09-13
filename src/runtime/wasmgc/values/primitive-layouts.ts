// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { Instr } from "../../../wasm/model/instructions.js";
import type { StructTypeDef } from "../../../wasm/model/module-records.js";

/** Exact five-field carrier shared by legacy and prepared native values. */
export function buildAnyValueType(): StructTypeDef {
  return {
    kind: "struct",
    name: "AnyValue",
    fields: [
      { name: "tag", type: { kind: "i32" }, mutable: false },
      { name: "i32val", type: { kind: "i32" }, mutable: false },
      { name: "f64val", type: { kind: "f64" }, mutable: false },
      { name: "refval", type: { kind: "eqref" }, mutable: false },
      { name: "externval", type: { kind: "externref" }, mutable: false },
    ],
  };
}

/** Canonical non-null undefined: tag 1, zero, NaN, null eq, null extern. */
export function buildUndefinedInitializer(anyTypeIdx: number): Instr[] {
  const EQ_HEAP_TYPE = -19; // WasmGC `eq` abstract heap type
  return [
    { op: "i32.const", value: 1 }, // tag = 1 (Undefined)
    { op: "i32.const", value: 0 }, // i32val
    { op: "f64.const", value: NaN }, // f64val
    { op: "ref.null", typeIdx: EQ_HEAP_TYPE }, // refval
    { op: "ref.null.extern" }, // externval
    { op: "struct.new", typeIdx: anyTypeIdx },
  ];
}

export function buildBoxNumberType(): StructTypeDef {
  return {
    kind: "struct",
    name: "__box_number_struct",
    fields: [{ name: "value", type: { kind: "f64" }, mutable: false }],
  };
}

export function buildBoxBooleanType(): StructTypeDef {
  return {
    kind: "struct",
    name: "__box_boolean_struct",
    fields: [{ name: "value", type: { kind: "i32" }, mutable: false }],
  };
}
