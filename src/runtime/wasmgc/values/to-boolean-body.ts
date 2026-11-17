// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr, LocalDef } from "../../../wasm/model/instructions.js";

/**
 * The carriers a ToBoolean (§7.1.2) ladder can meet. An absent carrier is `-1`: its value cannot reach the
 * caller, so its arm is not emitted.
 */
export interface ToBooleanLayout {
  /** `$AnyValue`: tag 0 (`null`) and 1 (`undefined`) are falsy, every other wrapped tag truthy (#2106 S1). */
  readonly anyValueTypeIdx: number;
  /** (#4173) Internalize the operand once and let the `$AnyValue` test's tee feed the ladder. */
  readonly internalizeOnce: boolean;
  readonly boxNumberTypeIdx: number;
  readonly boxBooleanTypeIdx: number;
  readonly bigIntTypeIdx: number;
  /** `$AnyString` (the length is field 0): `""` is falsy (#2080). */
  readonly anyStringTypeIdx: number;
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
  return [
    { op: "local.get", index: 0 },
    { op: "ref.is_null" },
    { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 0 }, { op: "return" }] },
    ...(anyValueTypeIdx >= 0
      ? [
          { op: "local.get", index: 0 } as Instr,
          { op: "any.convert_extern" } as Instr,
          { op: "local.tee", index: 1 } as Instr,
          ...arm(anyValueTypeIdx, [
            { op: "struct.get", typeIdx: anyValueTypeIdx, fieldIdx: 0 },
            { op: "i32.const", value: 1 },
            { op: "i32.gt_u" },
          ]),
        ]
      : []),
    ...((layout.internalizeOnce && anyValueTypeIdx >= 0
      ? [any()]
      : [{ op: "local.get", index: 0 }, { op: "any.convert_extern" }, { op: "local.tee", index: 1 }]) as Instr[]),
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
    ...(bigIntTypeIdx >= 0
      ? [
          any(),
          ...arm(bigIntTypeIdx, [
            { op: "struct.get", typeIdx: bigIntTypeIdx, fieldIdx: 0 },
            { op: "i64.eqz" },
            { op: "i32.eqz" },
          ]),
        ]
      : []),
    ...(anyStringTypeIdx >= 0
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
