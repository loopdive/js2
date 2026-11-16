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

/**
 * `(externref) -> i32` "is this value `undefined`?" under the singleton
 * regime: a tag-1 `$AnyValue` (the singleton), or a number box carrying the
 * `UNDEF_F64` sentinel bits (#2979: an `undefined` that crossed an f64 carrier).
 * A null externref answers 0 through the failing tests: null is not undefined.
 * Param 0 is the value; `scratchAnyLocal` is an anyref local.
 */
export function buildIsUndefinedBody(
  anyTypeIdx: number,
  boxNumberTypeIdx: number | undefined,
  scratchAnyLocal: number,
  undefF64Bits: bigint,
): Instr[] {
  const boxedNumArm: Instr[] =
    boxNumberTypeIdx !== undefined
      ? [
          { op: "local.get", index: scratchAnyLocal },
          { op: "ref.test", typeIdx: boxNumberTypeIdx },
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "i32" } },
            then: [
              { op: "local.get", index: scratchAnyLocal },
              { op: "ref.cast", typeIdx: boxNumberTypeIdx },
              { op: "struct.get", typeIdx: boxNumberTypeIdx, fieldIdx: 0 },
              { op: "i64.reinterpret_f64" },
              { op: "i64.const", value: undefF64Bits },
              { op: "i64.eq" },
            ],
            else: [{ op: "i32.const", value: 0 }],
          },
        ]
      : [{ op: "i32.const", value: 0 }];
  return [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "local.tee", index: scratchAnyLocal },
    { op: "ref.test", typeIdx: anyTypeIdx },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [
        { op: "local.get", index: scratchAnyLocal },
        { op: "ref.cast", typeIdx: anyTypeIdx },
        { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 0 },
        { op: "i32.const", value: 1 },
        { op: "i32.eq" },
      ],
      else: boxedNumArm,
    },
  ];
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
