// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { NativeDeclaredType } from "./native-resource-declaration-types.js";

/** Canonical open-object fields, kept in the legacy storage order. */
export function createObjectPropertyEntryDeclaration(): NativeDeclaredType {
  return {
    kind: "struct",
    name: "$PropEntry",
    fields: [
      { name: "key", type: { kind: "anyref" }, mutable: false },
      { name: "value", type: { kind: "anyref" }, mutable: true },
      { name: "flags", type: { kind: "i32" }, mutable: true },
      { name: "seq", type: { kind: "i32" }, mutable: true },
      { name: "get", type: { kind: "anyref" }, mutable: true },
      { name: "set", type: { kind: "anyref" }, mutable: true },
    ],
  };
}

export function createObjectPropertyMapDeclaration(entryKey: string): NativeDeclaredType {
  return { kind: "array", name: "$PropMap", element: { kind: "ref_null", typeKey: entryKey }, mutable: true };
}

/** Self is symbolic until the physical ledger issues this final, parentless type. */
export function createOpenObjectDeclaration(objectKey: string, mapKey: string): NativeDeclaredType {
  return {
    kind: "struct",
    name: "$Object",
    fields: [
      { name: "proto", type: { kind: "ref_null", typeKey: objectKey }, mutable: true },
      { name: "props", type: { kind: "ref", typeKey: mapKey }, mutable: true },
      { name: "count", type: { kind: "i32" }, mutable: true },
      { name: "tombstones", type: { kind: "i32" }, mutable: true },
      { name: "flags", type: { kind: "i32" }, mutable: true },
      { name: "nextSeq", type: { kind: "i32" }, mutable: true },
    ],
  };
}
