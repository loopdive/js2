// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr, LocalDef, ValType } from "../../../wasm/model/instructions.js";
import type { StructTypeDef } from "../../../wasm/model/module-records.js";
import type { NativeDeclaredType } from "./native-resource-declaration-types.js";
import { createOpenObjectDeclaration } from "./object-layouts.js";
import {
  createPrimitiveWrapperDeclaration,
  type PrimitiveWrapperKind,
  type PrimitiveWrapperTypeKeys,
} from "./primitive-wrapper-layouts.js";
import { createClosureCaptureType } from "./closure-capture-layouts.js";

export const REALM_STATE_PROTOTYPE_FIELD = 0;
export const REALM_STATE_IDENTITY_FIELD = 1;
export const REALM_ORDINARY_STATE_FIELD = 6;
export const REALM_WRAPPER_STATE_FIELD = 7;

/** The allocation identifies a realm. Structural type equality is not realm identity. */
export function createRealmIdentityDeclaration(): NativeDeclaredType {
  return { kind: "struct", name: "$RealmIdentity", fields: [] };
}

/** Actual [[Prototype]] is independent of the ordinary six-field own-storage prefix. */
export function createRealmObjectStateDeclaration(identityKey: string): NativeDeclaredType {
  return {
    kind: "struct",
    name: "$RealmObjectState",
    fields: [
      { name: "[[Prototype]]", type: { kind: "externref" }, mutable: true },
      { name: "[[Realm]]", type: { kind: "ref", typeKey: identityKey }, mutable: false },
    ],
  };
}

/** Only the eventual population owner can certify an allocation as Object.prototype. */
export function createRealmObjectPrototypeDeclaration(objectKey: string, mapKey: string): NativeDeclaredType {
  const root = createOpenObjectDeclaration(objectKey, mapKey);
  if (root.kind !== "struct") throw new Error("realm object layouts: ordinary prefix is not a struct");
  return { ...root, name: "$RealmObjectPrototype", parent: { kind: "resource", typeKey: objectKey }, final: true };
}

export function createRealmOrdinaryObjectDeclaration(
  objectKey: string,
  mapKey: string,
  stateKey: string,
): NativeDeclaredType {
  const root = createRealmObjectPrototypeDeclaration(objectKey, mapKey);
  if (root.kind !== "struct") throw new Error("realm object layouts: ordinary prefix is not a struct");
  return {
    ...root,
    name: "$RealmOrdinaryObject",
    fields: [...root.fields, { name: "[[ObjectState]]", type: { kind: "ref", typeKey: stateKey }, mutable: false }],
  };
}

/** Private payload stays at six; state follows the concrete payload, never the shared root. */
export function createRealmPrimitiveWrapperDeclaration(
  kind: PrimitiveWrapperKind,
  keys: PrimitiveWrapperTypeKeys,
  stateKey: string,
): NativeDeclaredType {
  const wrapper = createPrimitiveWrapperDeclaration(kind, keys);
  if (wrapper.kind !== "struct") throw new Error("realm object layouts: wrapper is not a struct");
  return {
    ...wrapper,
    fields: [...wrapper.fields, { name: "[[ObjectState]]", type: { kind: "ref", typeKey: stateKey }, mutable: false }],
  };
}

/** Captures retain their original coordinates, including the zero-capture case. */
export function createRealmSourceClosureType(
  name: string,
  superTypeIdx: number,
  captures: readonly ValType[],
  stateTypeIdx: number,
): StructTypeDef {
  const closure = createClosureCaptureType(name, superTypeIdx, captures);
  return {
    ...closure,
    final: true,
    fields: [
      ...closure.fields,
      { name: "[[ObjectState]]", type: { kind: "ref", typeIdx: stateTypeIdx }, mutable: false },
    ],
  };
}

/** Structural initializer only. Non-null anchors do not attest complete intrinsic population. */
export function buildRealmSourceStateInitializer(binding: {
  readonly realmGlobal: number;
  readonly prototypeGlobal: number;
  readonly stateType: number;
}): { locals: LocalDef[]; body: Instr[] } {
  return {
    locals: [],
    body: [
      { op: "global.get", index: binding.realmGlobal },
      { op: "ref.is_null" },
      { op: "if", blockType: { kind: "empty" }, then: [{ op: "unreachable" }] },
      { op: "global.get", index: binding.prototypeGlobal },
      { op: "ref.is_null" },
      { op: "if", blockType: { kind: "empty" }, then: [{ op: "unreachable" }] },
      { op: "global.get", index: binding.prototypeGlobal },
      { op: "global.get", index: binding.realmGlobal },
      { op: "ref.as_non_null" },
      { op: "struct.new", typeIdx: binding.stateType },
    ],
  };
}
