// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { ArrayTypeDef, StructTypeDef } from "../../../wasm/model/module-records.js";
import type { NativeDeclaredType } from "./native-resource-declaration-types.js";
import { buildBigIntPrimitiveType } from "./bigint-primitive-bodies.js";

/** The open base is shared by narrow values and main's canonical wide subtype. */
export function buildOpenBigIntType(): StructTypeDef {
  return { ...buildBigIntPrimitiveType(), superTypeIdx: -1 };
}

export function buildBigIntLimbsType(): ArrayTypeDef {
  return { kind: "array", name: "$BigIntLimbs", element: { kind: "i32" }, mutable: true };
}

function wideFields<T extends { kind: "ref" }>(magnitude: T) {
  return [
    { name: "value", type: { kind: "i64" as const, bigint: true }, mutable: false },
    { name: "sign", type: { kind: "i32" as const }, mutable: false },
    { name: "mag", type: magnitude, mutable: false },
  ];
}

export function buildWideBigIntType(baseTypeIdx: number, limbsTypeIdx: number): StructTypeDef {
  return {
    kind: "struct",
    name: "$BigIntWide",
    superTypeIdx: baseTypeIdx,
    fields: wideFields({ kind: "ref", typeIdx: limbsTypeIdx }),
  };
}

/** The same fields, with issued ledger keys instead of guessed physical indices. */
export function declareWideBigIntType(baseKey: string, limbsKey: string): NativeDeclaredType {
  return {
    kind: "struct",
    name: "$BigIntWide",
    parent: { kind: "resource", typeKey: baseKey },
    fields: wideFields({ kind: "ref", typeKey: limbsKey }),
  };
}
