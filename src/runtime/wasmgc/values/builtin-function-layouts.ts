// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { StructTypeDef } from "../../../wasm/model/module-records.js";
import { createBuiltinFunctionMetadataShape } from "./closure-layouts.js";

export const BUILTIN_FUNCTION_PROTOTYPE_FIELD = 5;
export const BUILTIN_FUNCTION_REALM_FIELD = 6;
export const BUILTIN_FUNCTION_INITIAL_NAME_FIELD = 7;
/**
 * (#7350 B2b) The `$Object.flags` bit of an object of which the realm models only an identity surface (a built-in the
 * program names but whose algorithms it does not have): a miss among its own properties is unknown, not absent. The
 * bits below it are the object runtime's (`OBJ_FLAG_*`, codegen/object-runtime.ts).
 */
export const BUILTIN_IDENTITY_ONLY_FLAG = 0x100;

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
