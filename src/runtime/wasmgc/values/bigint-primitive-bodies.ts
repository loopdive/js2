// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr } from "../../../wasm/model/instructions.js";
import type { StructTypeDef } from "../../../wasm/model/module-records.js";

/** Existing signed-i64 carrier only; not arbitrary-precision BigInt or ToBigInt. */
export function buildBigIntPrimitiveType(): StructTypeDef {
  return {
    kind: "struct",
    name: "$BigInt",
    fields: [{ name: "value", type: { kind: "i64", bigint: true }, mutable: false }],
  };
}

export function buildBoxBigIntBody(bigIntStructIdx: number): Instr[] {
  return [{ op: "local.get", index: 0 }, { op: "struct.new", typeIdx: bigIntStructIdx }, { op: "extern.convert_any" }];
}

export function buildTypeofBigIntBody(bigIntStructIdx: number): Instr[] {
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
    { op: "ref.test", typeIdx: bigIntStructIdx },
  ];
}
