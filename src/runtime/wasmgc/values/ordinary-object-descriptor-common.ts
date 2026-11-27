// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { FuncHandle, Instr, TypeHandle } from "../../../wasm/model/instructions.js";
import { DESCRIPTOR_WORD } from "../../../shared/contracts/descriptor-word.js";
import { OBJECT_FIELD } from "./object-layouts.js";

/**
 * The ordinary object's encodings, in one table: a property entry's flags (`writable` … `tombstone`), the object's own
 * flags (`nonExtensible` … `nullPrototype`, then the realm's brands (#7354 G1) [[ErrorData]] and (A1) the Array exotic
 * object, bits no legacy object flag uses: those stop at 0x400), and (`DESCRIPTOR_WORD`, shared with the IR) a
 * descriptor word's presence bits. Presence bits do not encode an operand value.
 */
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
  errorData: 0x800,
  arrayExotic: 0x1000,
  noneHeap: -18,
  writableSpecified: DESCRIPTOR_WORD.writableSpecified,
  enumerableSpecified: DESCRIPTOR_WORD.enumerableSpecified,
  configurableSpecified: DESCRIPTOR_WORD.configurableSpecified,
  hasValue: DESCRIPTOR_WORD.hasValue,
  getterSpecified: DESCRIPTOR_WORD.getterSpecified,
  setterSpecified: DESCRIPTOR_WORD.setterSpecified,
});

/** The `$Object` of the externref on the stack. */
export const asOrdinaryObject = (objectTypeIdx: number): Instr[] => [
  { op: "any.convert_extern" },
  { op: "ref.cast", typeIdx: objectTypeIdx },
];
/** The own flags word (`OBJECT_FIELD.flags`) of the object whose externref `object` pushes. */
export function objectFlags(objectTypeIdx: number, object: readonly Instr[]): Instr[] {
  return [
    ...object,
    ...asOrdinaryObject(objectTypeIdx),
    { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: OBJECT_FIELD.flags },
  ];
}
/** (#7354 G1, A1) `bit` (a realm brand) set in the flags of the object whose externref `object` pushes. */
export function markObjectFlag(objectTypeIdx: number, object: readonly Instr[], bit: number): Instr[] {
  return [
    ...object,
    ...asOrdinaryObject(objectTypeIdx),
    ...objectFlags(objectTypeIdx, object),
    { op: "i32.const", value: bit },
    { op: "i32.or" },
    { op: "struct.set", typeIdx: objectTypeIdx, fieldIdx: OBJECT_FIELD.flags },
  ];
}
/**
 * (#7354 A1) The realm's one brand dispatch of a define: `array` (the realm's ArrayDefineOwnProperty) where the object
 * whose externref `object` pushes is an Array exotic object, else `ordinary`, as one `if` of `blockType`.
 */
export function ifArrayBrand(
  objectTypeIdx: number,
  object: readonly Instr[],
  blockType: Extract<Instr, { op: "if" }>["blockType"],
  array: Instr[],
  ordinary: Instr[],
): Instr[] {
  return [
    ...objectFlags(objectTypeIdx, object),
    { op: "i32.const", value: ORDINARY_OBJECT_DESCRIPTOR_ENCODING.arrayExotic },
    { op: "i32.and" },
    { op: "if", blockType, then: array, ...(ordinary.length > 0 ? { else: ordinary } : {}) },
  ];
}
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
  /**
   * (#6770 S4) The define-REJECTION channel: when present, every
   * ValidateAndApplyPropertyDescriptor rejection parks its TypeError in this
   * externref global before throwing it, so `Reflect.defineProperty` can turn
   * exactly that throw into `false` (define-rejection-channel.ts).
   */
  readonly rejectionGlobal?: number;
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
  const park: Instr[] =
    d.rejectionGlobal === undefined
      ? []
      : [
          { op: "global.set", index: d.rejectionGlobal },
          { op: "global.get", index: d.rejectionGlobal },
        ];
  return [
    ...structuredClone(literal),
    { op: "call", funcIdx: d.constructorIdx },
    ...park,
    { op: "throw", tagIdx: d.tagIdx },
  ];
}
