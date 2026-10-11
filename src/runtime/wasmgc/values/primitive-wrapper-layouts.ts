// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { NativeDeclaredType, NativeDeclaredValType } from "./native-resource-declaration-types.js";
import { createOpenObjectDeclaration } from "./object-layouts.js";

export const PRIMITIVE_WRAPPER_KINDS = Object.freeze(["Boolean", "Number", "String", "Symbol", "BigInt"] as const);
export type PrimitiveWrapperKind = (typeof PRIMITIVE_WRAPPER_KINDS)[number];
export const PRIMITIVE_WRAPPER_DATA_FIELD = 6;

/** Symbolic shapes only; a backend owner must authenticate all issued prerequisites. */
export interface PrimitiveWrapperTypeKeys {
  readonly object: string;
  readonly propMap: string;
  readonly anyString: string;
  readonly symbol: string;
}

/**
 * An actual ordinary-object subtype, never a primitive carrier or a property-table
 * pseudo-slot. Distinct payload types are essential: Wasm field names do not brand
 * structurally identical subtypes. BigInt retains its original narrow/wide carrier.
 * This layout alone implements neither String exotic behavior nor ToObject.
 */
export function createPrimitiveWrapperDeclaration(
  kind: PrimitiveWrapperKind,
  keys: PrimitiveWrapperTypeKeys,
): NativeDeclaredType {
  if (!PRIMITIVE_WRAPPER_KINDS.includes(kind)) throw new Error("unknown primitive wrapper kind");
  const ordinary = createOpenObjectDeclaration(keys.object, keys.propMap);
  if (ordinary.kind !== "struct") throw new Error("ordinary object declaration is not a struct");
  const payload: Record<PrimitiveWrapperKind, NativeDeclaredValType> = {
    Boolean: { kind: "i32" },
    Number: { kind: "f64" },
    String: { kind: "ref", typeKey: keys.anyString },
    Symbol: { kind: "ref", typeKey: keys.symbol },
    BigInt: { kind: "externref" },
  };
  return {
    kind: "struct",
    name: "$" + kind + "Object",
    parent: { kind: "resource", typeKey: keys.object },
    final: true,
    fields: [...ordinary.fields, { name: "[[" + kind + "Data]]", type: payload[kind], mutable: false }],
  };
}
