// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { StructTypeDef } from "../../../wasm/model/module-records.js";
import { createBuiltinFunctionMetadataShape } from "./closure-layouts.js";

export const BUILTIN_FUNCTION_PROTOTYPE_FIELD = 5;
export const BUILTIN_FUNCTION_REALM_FIELD = 6;
export const BUILTIN_FUNCTION_INITIAL_NAME_FIELD = 7;
/**
 * (#7350 B2b, B3a) The `$Object.flags` bit of a bag whose object the realm models only as an identity (a built-in the
 * program names whose other own properties it lacks): a miss among its own properties is unknown, not absent. The bits
 * below it are the object runtime's (`OBJ_FLAG_*`, codegen/object-runtime.ts).
 */
export const BUILTIN_IDENTITY_ONLY_FLAG = 0x100;
/**
 * (#7580) The `$Object.flags` bit of a bag whose own properties never change after the realm is seeded: the IR answers
 * the built-in's statics without reading them, so a write that would take effect aborts.
 */
export const BUILTIN_FIXED_FLAG = 0x200;

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
