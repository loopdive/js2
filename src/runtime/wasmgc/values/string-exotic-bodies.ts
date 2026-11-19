// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr, LocalDef } from "../../../wasm/model/instructions.js";
import { PRIMITIVE_WRAPPER_DATA_FIELD } from "./primitive-wrapper-layouts.js";

/** Coordinates only; a backend owner must authenticate their actual providers. */
export interface StringExoticIndexBindings {
  readonly anyStrTypeIdx: number;
  readonly nativeStrTypeIdx: number;
  readonly nativeStrDataTypeIdx: number;
  readonly flattenIdx: number;
}
export interface StringVirtualDescriptorBindings extends StringExoticIndexBindings {
  readonly objectTypeIdx: number;
  readonly stringObjectTypeIdx: number;
  readonly propEntryTypeIdx: number;
  readonly indexIdx: number;
}
export interface StringOwnDescriptorBindings {
  readonly propEntryTypeIdx: number;
  readonly ordinaryFindIdx: number;
  readonly virtualOwnIdx: number;
}
function capture<T extends object>(input: T, keys: readonly (keyof T)[]): T {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw Error("String exotic: data bindings required");
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(descriptors).some((key) => !keys.includes(key as keyof T)))
    throw Error("String exotic: unknown binding");
  return Object.fromEntries(
    keys.map((key) => {
      const field = Object.hasOwn(descriptors, key) ? descriptors[key] : undefined;
      const value = field && Object.hasOwn(field, "value") ? field.value : undefined;
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 0xffffffff)
        throw Error("String exotic: missing/non-data/invalid binding " + String(key));
      return [key, value];
    }),
  ) as T;
}
const stringKeys = ["anyStrTypeIdx", "nativeStrTypeIdx", "nativeStrDataTypeIdx", "flattenIdx"] as const;
const get = (index: number): Instr => ({ op: "local.get", index });
const set = (index: number): Instr => ({ op: "local.set", index });
const integer = (value: number): Instr => ({ op: "i32.const", value });
const noIndex = (): Instr[] => [{ op: "i64.const", value: -1n }, { op: "return" }];

/** The immutable length-one view of the flat string in local `flat` at the in-bounds code-unit `index`. */
function codeUnitView(nativeStrTypeIdx: number, flat: number, index: readonly Instr[]): Instr[] {
  return [
    integer(1),
    get(flat),
    { op: "struct.get", typeIdx: nativeStrTypeIdx, fieldIdx: 1 },
    ...index,
    { op: "i32.add" },
    get(flat),
    { op: "struct.get", typeIdx: nativeStrTypeIdx, fieldIdx: 2 },
    { op: "struct.new", typeIdx: nativeStrTypeIdx },
  ];
}

/**
 * (canonical PropertyKey externref) -> unsigned array index as i64, or -1.
 * This is exact for all indices 0..2^32-2. It neither coerces keys nor uses the
 * legacy signed-i32/nine-digit approximation. Bounds on actual StringData are
 * checked separately. Symbols, leading zeroes and non-decimal forms are absent.
 */
export function buildStringExoticIndexDefinition(input: StringExoticIndexBindings): {
  locals: LocalDef[];
  body: Instr[];
} {
  const d = capture(input, stringKeys);
  return {
    locals: [
      { name: "flat", type: { kind: "ref", typeIdx: d.nativeStrTypeIdx } },
      ...["length", "offset", "cursor", "digit"].map((name): LocalDef => ({ name, type: { kind: "i32" } })),
      { name: "index", type: { kind: "i64" } },
    ],
    body: [
      get(0),
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: d.anyStrTypeIdx },
      { op: "i32.eqz" },
      { op: "if", blockType: { kind: "empty" }, then: noIndex() },
      get(0),
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: d.anyStrTypeIdx },
      { op: "call", funcIdx: d.flattenIdx },
      set(1),
      get(1),
      { op: "struct.get", typeIdx: d.nativeStrTypeIdx, fieldIdx: 0 },
      set(2),
      get(2),
      { op: "i32.eqz" },
      get(2),
      integer(10),
      { op: "i32.gt_u" },
      { op: "i32.or" },
      { op: "if", blockType: { kind: "empty" }, then: noIndex() },
      get(1),
      { op: "struct.get", typeIdx: d.nativeStrTypeIdx, fieldIdx: 1 },
      set(3),
      {
        op: "loop",
        blockType: { kind: "empty" },
        body: [
          get(1),
          { op: "struct.get", typeIdx: d.nativeStrTypeIdx, fieldIdx: 2 },
          get(3),
          get(4),
          { op: "i32.add" },
          { op: "array.get_u", typeIdx: d.nativeStrDataTypeIdx },
          integer(48),
          { op: "i32.sub" },
          { op: "local.tee", index: 5 },
          integer(9),
          { op: "i32.gt_u" },
          { op: "if", blockType: { kind: "empty" }, then: noIndex() },
          // Reject "00" and "01", but retain the single canonical key "0".
          get(4),
          { op: "i32.eqz" },
          get(5),
          { op: "i32.eqz" },
          { op: "i32.and" },
          get(2),
          integer(1),
          { op: "i32.gt_u" },
          { op: "i32.and" },
          { op: "if", blockType: { kind: "empty" }, then: noIndex() },
          get(6),
          { op: "i64.const", value: 10n },
          { op: "i64.mul" },
          get(5),
          { op: "i64.extend_i32_u" },
          { op: "i64.add" },
          set(6),
          get(4),
          integer(1),
          { op: "i32.add" },
          { op: "local.tee", index: 4 },
          get(2),
          { op: "i32.lt_u" },
          { op: "br_if", depth: 0 },
        ],
      },
      get(6),
      { op: "i64.const", value: 4294967294n },
      { op: "i64.gt_u" },
      { op: "if", blockType: { kind: "empty" }, then: noIndex() },
      get(6),
    ],
  };
}

/**
 * (ordinary Object, canonical PropertyKey) -> nullable virtual PropEntry.
 * Only the genuine String subtype has [[StringData]]. A present entry contains
 * exactly one UTF16 code unit, including an isolated surrogate; its stored
 * flags are enumerable only. No property table is modified by this lookup.
 */
export function buildStringVirtualOwnDescriptorDefinition(input: StringVirtualDescriptorBindings): {
  locals: LocalDef[];
  body: Instr[];
} {
  const d = capture(input, [...stringKeys, "objectTypeIdx", "stringObjectTypeIdx", "propEntryTypeIdx", "indexIdx"]);
  const absent: Instr[] = [{ op: "ref.null", typeIdx: d.propEntryTypeIdx }, { op: "return" }];
  return {
    locals: [
      { name: "payload", type: { kind: "ref", typeIdx: d.anyStrTypeIdx } },
      { name: "index", type: { kind: "i64" } },
      { name: "flat", type: { kind: "ref", typeIdx: d.nativeStrTypeIdx } },
    ],
    body: [
      get(0),
      { op: "ref.test", typeIdx: d.stringObjectTypeIdx },
      { op: "i32.eqz" },
      { op: "if", blockType: { kind: "empty" }, then: structuredClone(absent) },
      get(1),
      { op: "call", funcIdx: d.indexIdx },
      { op: "local.tee", index: 3 },
      { op: "i64.const", value: -1n },
      { op: "i64.eq" },
      { op: "if", blockType: { kind: "empty" }, then: structuredClone(absent) },
      get(0),
      { op: "ref.cast", typeIdx: d.stringObjectTypeIdx },
      { op: "struct.get", typeIdx: d.stringObjectTypeIdx, fieldIdx: PRIMITIVE_WRAPPER_DATA_FIELD },
      set(2),
      get(3),
      get(2),
      { op: "struct.get", typeIdx: d.anyStrTypeIdx, fieldIdx: 0 },
      { op: "i64.extend_i32_u" },
      { op: "i64.ge_u" },
      { op: "if", blockType: { kind: "empty" }, then: structuredClone(absent) },
      get(2),
      { op: "call", funcIdx: d.flattenIdx },
      set(4),
      get(1),
      { op: "any.convert_extern" }, // descriptor key
      ...codeUnitView(d.nativeStrTypeIdx, 4, [get(3), { op: "i32.wrap_i64" }]),
      integer(2),
      integer(0), // flags: enumerable; virtual entries have no creation sequence
      { op: "ref.null", typeIdx: -18 },
      { op: "ref.null", typeIdx: -18 },
      { op: "struct.new", typeIdx: d.propEntryTypeIdx },
    ],
  };
}

export interface StringCodeUnitReadBindings {
  readonly anyStrTypeIdx: number;
  readonly nativeStrTypeIdx: number;
  readonly flattenIdx: number;
  /** The global holding the `undefined` value. */
  readonly undefinedGlobalIdx: number;
}

/**
 * (externref string, f64 number key) -> externref: (#7352) a string primitive's own property at a number key
 * (§10.4.3.5 StringGetOwnProperty), its length-one view at an array index below its length, else `undefined`. A
 * number names an index exactly when it is an integer in range (CanonicalNumericIndexString of a number is the
 * number; -0 is index 0); NaN fails every comparison and the integer test.
 */
export function buildStringCodeUnitReadDefinition(input: StringCodeUnitReadBindings): {
  locals: LocalDef[];
  body: Instr[];
} {
  const d = capture(input, ["anyStrTypeIdx", "nativeStrTypeIdx", "flattenIdx", "undefinedGlobalIdx"]);
  return {
    locals: [
      { name: "string", type: { kind: "ref", typeIdx: d.anyStrTypeIdx } },
      { name: "flat", type: { kind: "ref", typeIdx: d.nativeStrTypeIdx } },
    ],
    body: [
      get(0),
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: d.anyStrTypeIdx },
      set(2),
      get(1),
      { op: "f64.const", value: 0 },
      { op: "f64.lt" },
      get(1),
      get(2),
      { op: "struct.get", typeIdx: d.anyStrTypeIdx, fieldIdx: 0 },
      { op: "f64.convert_i32_u" },
      { op: "f64.ge" },
      { op: "i32.or" },
      get(1),
      get(1),
      { op: "f64.trunc" },
      { op: "f64.ne" },
      { op: "i32.or" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "global.get", index: d.undefinedGlobalIdx }, { op: "extern.convert_any" }, { op: "return" }],
      },
      get(2),
      { op: "call", funcIdx: d.flattenIdx },
      set(3),
      ...codeUnitView(d.nativeStrTypeIdx, 3, [get(1), { op: "i32.trunc_f64_u" }]),
      { op: "extern.convert_any" },
    ],
  };
}

/** Shared own-descriptor lookup, suitable at every cursor of prototype traversal. */
export function buildStringExoticOwnDescriptorDefinition(input: StringOwnDescriptorBindings): {
  locals: LocalDef[];
  body: Instr[];
} {
  const d = capture(input, ["propEntryTypeIdx", "ordinaryFindIdx", "virtualOwnIdx"]);
  return {
    locals: [{ name: "ordinary", type: { kind: "ref_null", typeIdx: d.propEntryTypeIdx } }],
    body: [
      get(0),
      get(1),
      { op: "call", funcIdx: d.ordinaryFindIdx },
      { op: "local.tee", index: 2 },
      { op: "ref.is_null" },
      { op: "i32.eqz" },
      { op: "if", blockType: { kind: "empty" }, then: [get(2), { op: "return" }] },
      get(0),
      get(1),
      { op: "call", funcIdx: d.virtualOwnIdx },
    ],
  };
}
