// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { FuncHandle, Instr, TypeHandle } from "../../../wasm/model/instructions.js";

/** Existing descriptor encoding. Presence bits do not encode an operand value. */
export const ORDINARY_OBJECT_DESCRIPTOR_ENCODING = Object.freeze({
  writable: 1,
  enumerable: 2,
  configurable: 4,
  accessor: 8,
  tombstone: 128,
  nonExtensible: 1,
  sealed: 2,
  frozen: 4,
  nullPrototype: 128,
  noneHeap: -18,
  writableSpecified: 8,
  enumerableSpecified: 16,
  configurableSpecified: 32,
  hasValue: 128,
  getterSpecified: 256,
  setterSpecified: 512,
});
export interface OrdinaryDescriptorFlags {
  readonly writable: number;
  readonly enumerable: number;
  readonly configurable: number;
  readonly accessor: number;
  readonly nonExtensible: number;
  readonly sealed: number;
  readonly frozen: number;
  readonly noneHeap: TypeHandle;
}
export interface OrdinaryDescriptorErrors {
  readonly constructorIdx: FuncHandle;
  readonly tagIdx: number;
  /** Pre-acquired string literal operands, in the donor's evaluation order. */
  readonly messages: readonly (readonly Instr[])[];
}
export interface OrdinaryDescriptorResources {
  readonly objectTypeIdx: TypeHandle;
  readonly propEntryTypeIdx: TypeHandle;
  readonly objFindIdx: FuncHandle;
  /** Only an issued String descriptor selection supplies this virtual-first provider. */
  readonly stringVirtualOwnIdx?: FuncHandle;
  readonly objInsertIdx: FuncHandle;
  readonly objGrowIdx: FuncHandle;
  readonly sameValueIdx: FuncHandle;
  readonly flags: OrdinaryDescriptorFlags;
  readonly errors: OrdinaryDescriptorErrors;
}
export interface OrdinaryAccessorNonExtensible {
  /** Only legacy carrier substitution uses its original own-key dispatcher. */
  readonly ownKeyIdx: FuncHandle | undefined;
  readonly errors: OrdinaryDescriptorErrors;
}

export function descriptorFlagBit(local: number, bit: number): Instr[] {
  return [
    { op: "local.get", index: local },
    { op: "i32.const", value: bit },
    { op: "i32.and" },
    { op: "i32.const", value: 0 },
    { op: "i32.ne" },
  ];
}
export function descriptorTypeError(d: OrdinaryDescriptorErrors, ordinal: number): Instr[] {
  const literal = d.messages[ordinal];
  if (!literal) throw new Error("ordinary descriptor: missing error literal " + ordinal);
  return [...structuredClone(literal), { op: "call", funcIdx: d.constructorIdx }, { op: "throw", tagIdx: d.tagIdx }];
}
