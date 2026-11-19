// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7352 arrays) The realm's Array exotic object (ECMA-262 §10.4.2): an `$Array` is an ordinary `$Object` whose
 * index properties live in its `elements` vector (`$ObjVec`: length, backing store). A hole is any `$PropEntry`
 * in the store (the realm's hole sentinel), which no ECMAScript value is. The array's `length` is the vector's.
 *
 * Every body here is a pure builder over physical operands; the kernel's lookup asks `buildArrayOwnEntry`, the
 * source contracts `js.object.create-array` / `get-index` / `set-index` use the three definitions below.
 */
import type { FuncHandle, Instr, LocalDef } from "../../../wasm/model/instructions.js";
import { ORDINARY_OBJECT_DESCRIPTOR_ENCODING as flags } from "./ordinary-object-descriptor-common.js";
import { buildOrdinaryObjectCreateBody } from "./ordinary-object-storage-bodies.js";

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
interface Definition {
  readonly locals: LocalDef[];
  readonly body: Instr[];
}

/** `$Array.elements`: the field after the ordinary object's six. */
const ELEMENTS_FIELD = 6;
const get = (index: number): Instr => ({ op: "local.get", index });
const set = (index: number): Instr => ({ op: "local.set", index });
const empty = { kind: "empty" } as const;

const asArray = (d: ArrayExoticOperands, local: number): Instr[] => [
  get(local),
  { op: "any.convert_extern" },
  { op: "ref.cast", typeIdx: d.arrayTypeIdx },
];
const elements = (d: ArrayExoticOperands, local: number): Instr[] => [
  ...asArray(d, local),
  { op: "struct.get", typeIdx: d.arrayTypeIdx, fieldIdx: ELEMENTS_FIELD },
];
const length = (d: ArrayExoticOperands, local: number): Instr[] => [
  ...elements(d, local),
  { op: "struct.get", typeIdx: d.vectorTypeIdx, fieldIdx: 0 },
];
/** The stored element at the i32 index on the stack's top, after the array local. */
const element = (d: ArrayExoticOperands, local: number, index: Instr[]): Instr[] => [
  ...elements(d, local),
  { op: "struct.get", typeIdx: d.vectorTypeIdx, fieldIdx: 1 },
  ...index,
  { op: "array.get", typeIdx: d.vectorArrayTypeIdx },
];
const isHole = (d: ArrayExoticOperands, value: number): Instr[] => [
  get(value),
  { op: "any.convert_extern" },
  { op: "ref.test", typeIdx: d.entryTypeIdx },
];
const isArray = (d: ArrayExoticOperands, local: number): Instr[] => [
  get(local),
  { op: "any.convert_extern" },
  { op: "ref.test", typeIdx: d.arrayTypeIdx },
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
/** The index an f64 names when it is an array index (an integer in 0..2^32-2), else -1, as i64. */
const arrayIndexOf = (index: number): Instr[] => [
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
 * writable, non-enumerable, non-configurable data property and a present index an ordinary data property, both
 * answered from the vector; every other key, and every non-array object, from the ordinary map (`findOrdinary`).
 * Leaves the entry (or null) in `entry`; `index` (i64) and `value` (externref) are scratch locals.
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
    ...length(d, cursor),
    { op: "i64.extend_i32_u" },
    { op: "i64.lt_u" },
    { op: "i32.and" },
    {
      op: "if",
      blockType: empty,
      then: [
        ...element(d, cursor, [get(index), { op: "i32.wrap_i64" }]),
        set(value),
        ...isHole(d, value),
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
    ...isArray(d, cursor),
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
              [...length(d, cursor), { op: "f64.convert_i32_u" }, { op: "call", funcIdx: d.boxNumber }],
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

/** `js.object.create-array(length)`: ArrayCreate(length) on %Array.prototype%, every index a hole. */
export function buildArrayCreateDefinition(d: ArrayExoticOperands): Definition {
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
      get(1),
      { op: "global.get", index: d.hole },
      { op: "extern.convert_any" },
      get(1),
      { op: "array.new", typeIdx: d.vectorArrayTypeIdx },
      { op: "struct.new", typeIdx: d.vectorTypeIdx },
      { op: "struct.new", typeIdx: d.arrayTypeIdx },
      { op: "extern.convert_any" },
    ],
  };
}

/**
 * `js.object.get-index(object, index, receiver)`: [[Get]] with an array-index key that the array holds. The
 * Prepared resolver plans an index read only on an array literal that is never written, at a constant index
 * inside it (`prepare-ordinary-object-access.ts`), so the receiver is an `$Array` and the element present; the
 * prototype walk for a miss and the ordinary receiver come with the dynamic carrier (slice A2).
 */
export function buildArrayGetIndexDefinition(d: ArrayExoticOperands): Definition {
  return {
    locals: [
      { name: "index", type: { kind: "i64" } },
      { name: "value", type: { kind: "externref" } },
    ],
    body: [
      ...isArray(d, 0),
      { op: "i32.eqz" },
      { op: "if", blockType: empty, then: [{ op: "unreachable" }] },
      ...arrayIndexOf(1),
      { op: "local.tee", index: 3 },
      ...length(d, 0),
      { op: "i64.extend_i32_u" },
      { op: "i64.ge_u" },
      { op: "if", blockType: empty, then: [{ op: "unreachable" }] },
      ...element(d, 0, [get(3), { op: "i32.wrap_i64" }]),
      { op: "local.tee", index: 4 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: d.entryTypeIdx },
      { op: "if", blockType: empty, then: [{ op: "unreachable" }] },
      get(4),
    ],
  };
}

/**
 * `js.object.set-index(object, index, value)`: [[Set]] of an array index on an `$Array` — the element store grows
 * the vector, holes fill the gap, and the length follows (`elementStore` is the shared vector grow/store helper).
 * Its callers so far store an array literal's own elements; a non-array receiver or a non-index number reaches the
 * string-keyed [[Set]] once the dynamic carrier admits them (slice A2).
 */
export function buildArraySetIndexDefinition(d: ArrayExoticOperands, elementStore: FuncHandle): Definition {
  return {
    locals: [{ name: "index", type: { kind: "i64" } }],
    body: [
      ...isArray(d, 0),
      { op: "i32.eqz" },
      { op: "if", blockType: empty, then: [{ op: "unreachable" }] },
      ...arrayIndexOf(1),
      { op: "local.tee", index: 3 },
      { op: "i64.const", value: 2147483647n },
      { op: "i64.gt_u" },
      { op: "if", blockType: empty, then: [{ op: "unreachable" }] },
      ...elements(d, 0),
      get(3),
      { op: "i32.wrap_i64" },
      get(2),
      { op: "call", funcIdx: elementStore },
    ],
  };
}
