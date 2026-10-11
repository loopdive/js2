// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { Instr, LocalDef } from "../../../wasm/model/instructions.js";

/** Typed Boolean carrier extraction; this is not general JavaScript ToBoolean. */
export function buildUnboxBooleanBody(boxBoolStructIdx: number): Instr[] {
  return [
    { op: "local.get", index: 0 },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "i32.const", value: 0 }, { op: "return" }],
    },
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "local.tee", index: 1 },
    { op: "ref.test", typeIdx: boxBoolStructIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 1 },
        { op: "ref.cast", typeIdx: boxBoolStructIdx },
        { op: "struct.get", typeIdx: boxBoolStructIdx, fieldIdx: 0 },
        { op: "return" },
      ],
    },
    // not a boxed bool → false (conservative under wasi)
    { op: "i32.const", value: 0 },
  ];
}

export function buildUnboxBooleanLocals(): LocalDef[] {
  return [{ name: "$any_temp", type: { kind: "anyref" } }];
}

export function buildTypeofBooleanBody(boxBoolStructIdx: number): Instr[] {
  return [
    { op: "local.get", index: 0 },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "i32.const", value: 0 }, { op: "return" }],
    },
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: boxBoolStructIdx },
  ];
}

export type BooleanBoxBodyBindings =
  | { readonly mode: "allocating"; readonly typeIndex: number }
  | { readonly mode: "interned"; readonly trueGlobalIndex: number; readonly falseGlobalIndex: number };

/** Exact legacy primitive boxing recipe; allocation policy is explicit. */
export function buildBoxBooleanBody(bindings: BooleanBoxBodyBindings): Instr[] {
  if (bindings.mode === "allocating")
    return [
      { op: "local.get", index: 0 },
      { op: "struct.new", typeIdx: bindings.typeIndex },
      { op: "extern.convert_any" },
    ];
  return [
    { op: "local.get", index: 0 },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "externref" } },
      then: [{ op: "global.get", index: bindings.trueGlobalIndex }, { op: "extern.convert_any" }],
      else: [{ op: "global.get", index: bindings.falseGlobalIndex }, { op: "extern.convert_any" }],
    },
  ];
}

export function buildBooleanBoxInitializer(typeIndex: number, value: 0 | 1): Instr[] {
  return [
    { op: "i32.const", value },
    { op: "struct.new", typeIdx: typeIndex },
  ];
}
