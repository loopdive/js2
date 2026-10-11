// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { StructTypeDef } from "../../../wasm/model/module-records.js";
import { createBuiltinFunctionMetadataShape } from "./closure-layouts.js";

export const BUILTIN_FUNCTION_PROTOTYPE_FIELD = 5;
export const BUILTIN_FUNCTION_REALM_FIELD = 6;
export const BUILTIN_FUNCTION_INITIAL_NAME_FIELD = 7;

/** Identity is the allocation, not an integer brand or a canonicalized type. */
export function createBuiltinFunctionRealmType(name: string): StructTypeDef {
  return { kind: "struct", name, fields: [] };
}

/** The five-field metadata parent and all old source layouts remain unchanged. */
export function createBuiltinFunctionType(
  name: string,
  metadataTypeIdx: number,
  realmTypeIdx: number,
  stringTypeIdx: number,
): StructTypeDef {
  return {
    kind: "struct",
    name,
    superTypeIdx: metadataTypeIdx,
    final: true,
    fields: [
      ...createBuiltinFunctionMetadataShape("", metadataTypeIdx).fields,
      { name: "[[Prototype]]", type: { kind: "externref" }, mutable: true },
      { name: "[[Realm]]", type: { kind: "ref", typeIdx: realmTypeIdx }, mutable: false },
      { name: "[[InitialName]]", type: { kind: "ref", typeIdx: stringTypeIdx }, mutable: false },
    ],
  };
}
