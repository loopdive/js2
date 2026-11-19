// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { Instr, LocalDef } from "../../../wasm/model/instructions.js";
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

/**
 * The carriers a ToBoolean (§7.1.2) ladder can meet. An absent carrier is `undefined`: its value cannot reach
 * the caller, so its arm is not emitted.
 */
export interface ToBooleanLayout {
  /** `$AnyValue`: tag 0 (`null`) and 1 (`undefined`) are falsy, every other wrapped tag truthy (#2106 S1). */
  readonly anyValueTypeIdx: number | undefined;
  /** (#4173) Internalize the operand once and let the `$AnyValue` test's tee feed the ladder. */
  readonly internalizeOnce: boolean;
  readonly boxNumberTypeIdx: number;
  readonly boxBooleanTypeIdx: number;
  readonly bigIntTypeIdx: number | undefined;
  /** `$AnyString` (the length is field 0): `""` is falsy (#2080). */
  readonly anyStringTypeIdx: number | undefined;
}

export function buildToBooleanLocals(): LocalDef[] {
  return [
    { name: "$any_temp", type: { kind: "anyref" } },
    { name: "$f64_temp", type: { kind: "f64" } },
  ];
}

/** A `ref.test $T` arm that returns the payload read by `tail` from the cast operand. */
function arm(typeIdx: number, tail: Instr[]): Instr[] {
  return [
    { op: "ref.test", typeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "local.get", index: 1 }, { op: "ref.cast", typeIdx }, ...tail, { op: "return" }],
    },
  ];
}

/**
 * `(externref) -> i32` ToBoolean over the native carriers: the null reference (`null`) is falsy, a number is
 * falsy for ±0 and NaN, a Boolean is its payload, and any other non-null reference is truthy. The ordinary
 * pipeline's `__is_truthy` and the Prepared dynamic value's `js.value.to_boolean` are this one body.
 */
export function buildToBooleanBody(layout: ToBooleanLayout): Instr[] {
  const { anyValueTypeIdx, boxNumberTypeIdx, boxBooleanTypeIdx, bigIntTypeIdx, anyStringTypeIdx } = layout;
  const any = (): Instr => ({ op: "local.get", index: 1 });
  const internalize = (): Instr[] =>
    [{ op: "local.get", index: 0 }, { op: "any.convert_extern" }, { op: "local.tee", index: 1 }] satisfies Instr[];
  return [
    { op: "local.get", index: 0 },
    { op: "ref.is_null" },
    { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 0 }, { op: "return" }] },
    ...(anyValueTypeIdx !== undefined
      ? [
          ...internalize(),
          ...arm(anyValueTypeIdx, [
            { op: "struct.get", typeIdx: anyValueTypeIdx, fieldIdx: 0 },
            { op: "i32.const", value: 1 },
            { op: "i32.gt_u" },
          ]),
        ]
      : []),
    ...(layout.internalizeOnce && anyValueTypeIdx !== undefined ? [any()] : internalize()),
    // (#3673) An i31 small int cannot be NaN.
    ...arm(-20, [{ op: "i31.get_s" }, { op: "i32.const", value: 0 }, { op: "i32.ne" }]),
    any(),
    ...arm(boxNumberTypeIdx, [
      { op: "struct.get", typeIdx: boxNumberTypeIdx, fieldIdx: 0 },
      { op: "local.tee", index: 2 },
      { op: "f64.const", value: 0 },
      { op: "f64.ne" },
      { op: "local.get", index: 2 },
      { op: "local.get", index: 2 },
      { op: "f64.eq" },
      { op: "i32.and" },
    ]),
    any(),
    ...arm(boxBooleanTypeIdx, [{ op: "struct.get", typeIdx: boxBooleanTypeIdx, fieldIdx: 0 }]),
    ...(bigIntTypeIdx !== undefined
      ? [
          any(),
          ...arm(bigIntTypeIdx, [
            { op: "struct.get", typeIdx: bigIntTypeIdx, fieldIdx: 0 },
            { op: "i64.eqz" },
            { op: "i32.eqz" },
          ]),
        ]
      : []),
    ...(anyStringTypeIdx !== undefined
      ? [
          any(),
          ...arm(anyStringTypeIdx, [
            { op: "struct.get", typeIdx: anyStringTypeIdx, fieldIdx: 0 },
            { op: "i32.const", value: 0 },
            { op: "i32.ne" },
          ]),
        ]
      : []),
    { op: "i32.const", value: 1 },
  ];
}
