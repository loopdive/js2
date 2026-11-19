// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7352 arrays) The realm's Array exotic object (ECMA-262 §10.4.2): an `$Array` is an ordinary `$Object` with its
 * own `length` and an `elements` vector (`$ObjVec`: length, backing store). The vector is the dense prefix: it holds
 * every index below its own length, where a hole is any `$PropEntry` in the store (the realm's hole sentinel, which
 * no ECMAScript value is). An index at or above the vector's length is a property of the inherited map under its
 * canonical index string, so a sparse or huge index never allocates. A read looks in the vector, then in the map.
 *
 * Every body here is a pure builder over physical operands: the layout readers the sibling modules share, the
 * kernel's own-property arm (`buildArrayOwnEntry`), the initializer step, `js.object.create-array` and
 * `js.object.is-array`. The index
 * contracts are in `array-index-bodies.ts`, ArraySetLength in `array-length-bodies.ts`.
 */
import type { FuncHandle, Instr } from "../../../wasm/model/instructions.js";
import { ORDINARY_OBJECT_DESCRIPTOR_ENCODING as flags } from "./ordinary-object-descriptor-common.js";
import { buildOrdinaryObjectCreateBody } from "./ordinary-object-storage-bodies.js";
import type { SourceObjectDefinition } from "./source-object-bodies.js";

export interface ArrayExoticOperands {
  readonly arrayTypeIdx: number;
  readonly objectTypeIdx: number;
  readonly propMapTypeIdx: number;
  readonly entryTypeIdx: number;
  readonly vectorTypeIdx: number;
  readonly vectorArrayTypeIdx: number;
  /** Global holding the realm's hole sentinel, a `$PropEntry` the kernel initializer allocates. */
  readonly hole: number;
  /** Global holding %Array.prototype%, allocated by the kernel initializer. */
  readonly arrayPrototype: number;
  readonly initializer: FuncHandle;
}
/** The extra operands of the kernel's own-property arm. */
export interface ArrayOwnEntryOperands extends ArrayExoticOperands {
  readonly lengthKey: readonly Instr[];
  readonly sameValue: FuncHandle;
  readonly arrayIndex: FuncHandle;
  readonly boxNumber: FuncHandle;
}
/** What the kernel holds for arrays: the own-property operands and the prototype's constructor. */
export interface ArrayRealmOperands extends ArrayOwnEntryOperands {
  readonly createWithPrototype: FuncHandle;
}

/** `$Array`'s own fields, after the ordinary object's six. */
const ELEMENTS_FIELD = 6;
const LENGTH_FIELD = 7;
/**
 * The density bound: an index is stored in the vector while it is below the vector's length plus this many slots,
 * and a new array's store is presized for its length only up to it.
 */
export const ARRAY_DENSITY_BOUND = 1024;
const get = (index: number): Instr => ({ op: "local.get", index });
const set = (index: number): Instr => ({ op: "local.set", index });
const empty = { kind: "empty" } as const;

export const arrayRef = (d: ArrayExoticOperands, local: number): Instr[] => [
  get(local),
  { op: "any.convert_extern" },
  { op: "ref.cast", typeIdx: d.arrayTypeIdx },
];
export const arrayTest = (d: ArrayExoticOperands, local: number): Instr[] => [
  get(local),
  { op: "any.convert_extern" },
  { op: "ref.test", typeIdx: d.arrayTypeIdx },
];
/** The array's `length`, a u32. */
export const arrayLength = (d: ArrayExoticOperands, local: number): Instr[] => [
  ...arrayRef(d, local),
  { op: "struct.get", typeIdx: d.arrayTypeIdx, fieldIdx: LENGTH_FIELD },
];
/** Stores the i32 that `length` leaves as the array's `length`. */
export const arraySetLength = (d: ArrayExoticOperands, local: number, length: Instr[]): Instr[] => [
  ...arrayRef(d, local),
  ...length,
  { op: "struct.set", typeIdx: d.arrayTypeIdx, fieldIdx: LENGTH_FIELD },
];
export const arrayElements = (d: ArrayExoticOperands, local: number): Instr[] => [
  ...arrayRef(d, local),
  { op: "struct.get", typeIdx: d.arrayTypeIdx, fieldIdx: ELEMENTS_FIELD },
];
/** The vector's length: the indices below it are the vector's. */
export const arrayDenseLength = (d: ArrayExoticOperands, local: number): Instr[] => [
  ...arrayElements(d, local),
  { op: "struct.get", typeIdx: d.vectorTypeIdx, fieldIdx: 0 },
];
export const arrayStore = (d: ArrayExoticOperands, local: number): Instr[] => [
  ...arrayElements(d, local),
  { op: "struct.get", typeIdx: d.vectorTypeIdx, fieldIdx: 1 },
];
/** The stored element (a value or a hole) at the i32 that `index` leaves, which is below the vector's length. */
export const arrayDenseElement = (d: ArrayExoticOperands, local: number, index: Instr[]): Instr[] => [
  ...arrayStore(d, local),
  ...index,
  { op: "array.get", typeIdx: d.vectorArrayTypeIdx },
];
export const arrayHoleTest = (d: ArrayExoticOperands, value: number): Instr[] => [
  get(value),
  { op: "any.convert_extern" },
  { op: "ref.test", typeIdx: d.entryTypeIdx },
];
export const arrayHole = (d: ArrayExoticOperands): Instr[] => [
  { op: "global.get", index: d.hole },
  { op: "extern.convert_any" },
];
/** A fresh data entry (key, value, attributes) for a property the array holds outside its map. */
const dataEntry = (d: ArrayExoticOperands, key: number, value: Instr[], attributes: number): Instr[] => [
  get(key),
  { op: "any.convert_extern" },
  ...value,
  { op: "any.convert_extern" },
  { op: "i32.const", value: attributes },
  { op: "i32.const", value: 0 },
  { op: "ref.null.eq" },
  { op: "ref.null.eq" },
  { op: "struct.new", typeIdx: d.entryTypeIdx },
];
/**
 * The one classification of a number key: the index an f64 names when it is an array index (an integer in
 * 0..2^32-2; CanonicalNumericIndexString of a number is the number, so 1.0 and -0 name 1 and 0), else -1, as i64.
 * A string key is classified by the kernel's `arrayIndex` alone.
 */
export const arrayIndexOf = (index: number): Instr[] => [
  get(index),
  { op: "f64.const", value: 4294967294 },
  { op: "f64.le" },
  get(index),
  { op: "f64.trunc" },
  get(index),
  { op: "f64.eq" },
  { op: "i32.and" },
  get(index),
  { op: "f64.const", value: 0 },
  { op: "f64.ge" },
  { op: "i32.and" },
  {
    op: "if",
    blockType: { kind: "val", type: { kind: "i64" } },
    then: [get(index), { op: "i64.trunc_sat_f64_s" }],
    else: [{ op: "i64.const", value: -1n }],
  },
];

/**
 * The kernel's own-property step for `cursor` (§10.4.2 via OrdinaryGetOwnProperty): on an `$Array`, `length` is a
 * writable, non-enumerable, non-configurable data property and an index the vector holds an ordinary data property;
 * every other key (an index above the vector or in one of its holes among them), and every non-array object, is
 * answered from the ordinary map (`findOrdinary`). Leaves the entry (or null) in `entry`; `index` (i64) and `value`
 * (externref) are scratch locals.
 */
export function buildArrayOwnEntry(
  d: ArrayOwnEntryOperands,
  findOrdinary: Instr[],
  locals: {
    readonly cursor: number;
    readonly key: number;
    readonly entry: number;
    readonly index: number;
    readonly value: number;
  },
): Instr[] {
  const { cursor, key, entry, index, value } = locals;
  const ordinary = [...findOrdinary, set(entry)];
  const indexed: Instr[] = [
    get(key),
    { op: "call", funcIdx: d.arrayIndex },
    { op: "local.tee", index },
    { op: "i64.const", value: 0n },
    { op: "i64.ge_s" },
    get(index),
    ...arrayDenseLength(d, cursor),
    { op: "i64.extend_i32_u" },
    { op: "i64.lt_u" },
    { op: "i32.and" },
    {
      op: "if",
      blockType: empty,
      then: [
        ...arrayDenseElement(d, cursor, [get(index), { op: "i32.wrap_i64" }]),
        set(value),
        ...arrayHoleTest(d, value),
        { op: "i32.eqz" },
        {
          op: "if",
          blockType: empty,
          then: [
            ...dataEntry(d, key, [get(value)], flags.writable | flags.enumerable | flags.configurable),
            set(entry),
          ],
        },
      ],
    },
    get(entry),
    { op: "ref.is_null" },
    { op: "if", blockType: empty, then: ordinary },
  ];
  return [
    { op: "ref.null", typeIdx: d.entryTypeIdx },
    set(entry),
    ...arrayTest(d, cursor),
    {
      op: "if",
      blockType: empty,
      then: [
        get(key),
        ...structuredClone(d.lengthKey),
        { op: "call", funcIdx: d.sameValue },
        {
          op: "if",
          blockType: empty,
          then: [
            ...dataEntry(
              d,
              key,
              [...arrayLength(d, cursor), { op: "f64.convert_i32_u" }, { op: "call", funcIdx: d.boxNumber }],
              flags.writable,
            ),
            set(entry),
          ],
          else: indexed,
        },
      ],
      else: ordinary,
    },
  ];
}

/** Initializer step: %Array.prototype% (an ordinary object on Object.prototype) and the hole sentinel. */
export function buildArrayRealmAllocation(d: ArrayRealmOperands, objectPrototype: number): Instr[] {
  return [
    { op: "global.get", index: objectPrototype },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: d.objectTypeIdx },
    { op: "call", funcIdx: d.createWithPrototype },
    { op: "global.set", index: d.arrayPrototype },
    { op: "ref.null.eq" },
    { op: "ref.null.eq" },
    { op: "i32.const", value: 0 },
    { op: "i32.const", value: 0 },
    { op: "ref.null.eq" },
    { op: "ref.null.eq" },
    { op: "struct.new", typeIdx: d.entryTypeIdx },
    { op: "global.set", index: d.hole },
  ];
}

/**
 * `js.object.create-array(length)`: ArrayCreate(length) on %Array.prototype%. Every index is absent: the vector
 * starts empty, and its store is presized for `length` only up to the density bound, so a length never allocates
 * its own size.
 */
export function buildArrayCreateDefinition(d: ArrayExoticOperands): SourceObjectDefinition {
  const ordinaryFields = buildOrdinaryObjectCreateBody({
    objectTypeIdx: d.objectTypeIdx,
    propMapTypeIdx: d.propMapTypeIdx,
    initialCapacity: 8,
  }).slice(1, 7);
  return {
    locals: [{ name: "length", type: { kind: "i32" } }],
    body: [
      { op: "call", funcIdx: d.initializer },
      get(0),
      { op: "i32.trunc_sat_f64_u" },
      set(1),
      { op: "global.get", index: d.arrayPrototype },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: d.objectTypeIdx },
      ...ordinaryFields,
      { op: "i32.const", value: 0 },
      ...arrayHole(d),
      get(1),
      { op: "i32.const", value: ARRAY_DENSITY_BOUND },
      get(1),
      { op: "i32.const", value: ARRAY_DENSITY_BOUND },
      { op: "i32.lt_u" },
      { op: "select" },
      { op: "array.new", typeIdx: d.vectorArrayTypeIdx },
      { op: "struct.new", typeIdx: d.vectorTypeIdx },
      get(1),
      { op: "struct.new", typeIdx: d.arrayTypeIdx },
      { op: "extern.convert_any" },
    ],
  };
}

/** `js.object.is-array(value)`: IsArray (§15.4.3.2), the `$Array` brand; null and every primitive fail it. */
export function buildArrayIsArrayDefinition(d: ArrayExoticOperands): SourceObjectDefinition {
  return { locals: [], body: arrayTest(d, 0) };
}
