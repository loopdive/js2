// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr, ValType } from "../../../wasm/model/instructions.js";
import type { NativeNumberUndefinedInstruction } from "../../../ir/backend/native-number-undefined.js";
import { JS_TAG_IDS, type NativeNumberUndefinedLinearBindings } from "./native-number-undefined-layout.js";
export {
  requireNativeNumberUndefinedBoxLayout,
  describeNativeNumberUndefinedMemory,
  type NativeNumberUndefinedLinearBindings,
} from "./native-number-undefined-layout.js";
export {
  requirePreparedLinearNumberUndefinedSignatureCarrier,
  requirePreparedLinearNumberUndefinedBindings,
  type PreparedLinearMemoryReservations,
} from "./memory.js";
import { PreparedIrProgramInvariantError } from "../../../ir/program/errors.js";

function fail(detail: string): never {
  throw new PreparedIrProgramInvariantError("emission-failed", "native Number/Undefined Linear: " + detail);
}

/** Require the existing frozen-facts planner's geometry; never manufacture a replacement layout. */

/** Issued only by the existing checked memory pack after its reservations are frozen. */

export function emitNativeNumberUndefinedLinear(
  bindings: NativeNumberUndefinedLinearBindings,
  instr: NativeNumberUndefinedInstruction,
  operands: readonly (readonly Instr[])[],
  scratch: (type: ValType) => number,
): readonly Instr[] {
  bindings.assertCurrent();
  const tag = (local: number): Instr[] => [
    { op: "local.get", index: local },
    { op: "i32.load", align: 2, offset: 0 },
  ];
  const value = (local: number): Instr[] => [
    { op: "local.get", index: local },
    { op: "f64.load", align: 3, offset: 8 },
  ];
  if (instr.kind === "const") {
    if (instr.value.kind !== "undefined" || operands.length) fail("unexpected constant");
    return [{ op: "global.get", index: bindings.singletonGlobalIndex }];
  }
  if (instr.kind === "box") {
    if (
      instr.alloc === undefined ||
      operands.length !== 1 ||
      instr.toType.kind !== "dynamic" ||
      (instr.toType.tag !== undefined && instr.toType.tag !== JS_TAG_IDS.NumberF64)
    )
      fail("unowned box");
    bindings.requireBox(instr.alloc);
    const payload = scratch({ kind: "f64" }),
      pointer = scratch({ kind: "i32" });
    return [
      ...operands[0]!,
      { op: "local.set", index: payload },
      { op: "i32.const", value: 16 },
      { op: "call", funcIdx: bindings.allocatorIndex },
      { op: "local.set", index: pointer },
      { op: "local.get", index: pointer },
      { op: "i32.const", value: Number(JS_TAG_IDS.NumberF64) },
      { op: "i32.store", align: 2, offset: 0 },
      { op: "local.get", index: pointer },
      { op: "i32.const", value: 8 },
      { op: "i32.store", align: 2, offset: 4 },
      { op: "local.get", index: pointer },
      { op: "local.get", index: payload },
      { op: "f64.store", align: 3, offset: 8 },
      { op: "local.get", index: pointer },
    ];
  }
  const left = scratch({ kind: "i32" });
  if (instr.kind === "tag.test") {
    if (operands.length !== 1 || (instr.tagId !== JS_TAG_IDS.Undefined && instr.tagId !== JS_TAG_IDS.NumberF64))
      fail("unsupported tag probe");
    return [
      ...operands[0]!,
      { op: "local.set", index: left },
      ...tag(left),
      {
        op: "i32.const",
        value: Number(instr.tagId),
      },
      { op: "i32.eq" },
    ];
  }
  if (instr.kind === "dyn.to_number") {
    if (operands.length !== 1) fail("numeric conversion operands differ");
    return [
      ...operands[0]!,
      { op: "local.set", index: left },
      ...tag(left),
      { op: "i32.const", value: Number(JS_TAG_IDS.Undefined) },
      { op: "i32.eq" },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "f64" } },
        then: [{ op: "f64.const", value: NaN }],
        else: value(left),
      },
    ];
  }
  if (instr.loose !== false || typeof instr.negate !== "boolean" || operands.length !== 2) fail("unsupported equality");
  const right = scratch({ kind: "i32" });
  const undef = (local: number): Instr[] => [
    ...tag(local),
    { op: "i32.const", value: Number(JS_TAG_IDS.Undefined) },
    { op: "i32.eq" },
  ];
  return [
    ...operands[0]!,
    { op: "local.set", index: left },
    ...operands[1]!,
    { op: "local.set", index: right },
    ...undef(left),
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: undef(right),
      else: [
        ...undef(right),
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "i32" } },
          then: [{ op: "i32.const", value: 0 }],
          else: [...value(left), ...value(right), { op: "f64.eq" }],
        },
      ],
    },
    ...(instr.negate ? [{ op: "i32.eqz" } as Instr] : []),
  ];
}
