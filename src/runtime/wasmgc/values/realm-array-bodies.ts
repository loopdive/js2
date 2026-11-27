// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 A1) The realm's Array exotic object (§10.4.2): an ordinary object of the realm carrying the `arrayExotic`
 * brand of its flags, whose index properties and `length` are ordinary own data properties of its property map. Every
 * get, has, own-key walk and descriptor read is therefore the ordinary object's; only [[DefineOwnProperty]] differs
 * (§10.4.2.1), and it is the one function {@link buildArrayDefineDefinition}, which every realm define of an array
 * goes through: the descriptor pack's boundary defines (DefinePropertyOrThrow: the array and object literals,
 * `Object.defineProperty` / `defineProperties` / `create`) and OrdinarySet (`js.object.set`, which answers its
 * boolean). The kernel's own seeding defines (a function's `length` / `name`, a family object's properties) never target
 * an array but %Array.prototype%, whose own `length` they create.
 */
import type { FuncHandle, Instr, LocalDef } from "../../../wasm/model/instructions.js";
import {
  ORDINARY_OBJECT_DESCRIPTOR_ENCODING as flags,
  asOrdinaryObject,
  markObjectFlag,
} from "./ordinary-object-descriptor-common.js";
import { OBJECT_FIELD, PROP_ENTRY_FIELD } from "./object-layouts.js";
import { buildClosureUndefinedTest } from "./closure-receiver-bodies.js";

/** The realm string literals the array bodies read. */
export const REALM_ARRAY_LITERALS = Object.freeze(["Invalid array length", "Cannot redefine property: length"]);

export interface RealmArrayOperands {
  readonly objectTypeIdx: number;
  readonly entryTypeIdx: number;
  readonly mapTypeIdx: number;
  readonly boxedBooleanTypeIdx: number;
  /** The global holding %Array.prototype%, and the realm's initializer that fills it. */
  readonly prototype: number;
  readonly initializer: FuncHandle;
  readonly createWithPrototype: FuncHandle;
  /** The storage's own-entry find `(object, key) -> entry`, and the kernel's DeleteOwn `(object, key) -> i32`. */
  readonly findOwn: FuncHandle;
  readonly deleteOwn: FuncHandle;
  /** The kernel's index of an array index key `(key) -> i64`, -1 for any other key. */
  readonly arrayIndex: FuncHandle;
  /** The descriptor pack's ValidateAndApplyPropertyDescriptor, data and accessor (each throws on a rejection). */
  readonly defineDataBody: FuncHandle;
  readonly defineAccessorBody: FuncHandle;
  readonly boxNumber: FuncHandle;
  readonly unboxNumber: FuncHandle;
  readonly isNumber: FuncHandle;
  readonly anyValueTypeIdx: number;
  readonly lengthKey: readonly Instr[];
  /** A thrown TypeError / RangeError whose message is a realm literal (`REALM_ARRAY_LITERALS`). */
  readonly throwTypeError: (message: string) => Instr[];
  readonly throwRangeError: (message: string) => Instr[];
}
type Definition = { locals: LocalDef[]; body: Instr[] };

const get = (index: number): Instr => ({ op: "local.get", index });
const set = (index: number): Instr => ({ op: "local.set", index });
const tee = (index: number): Instr => ({ op: "local.tee", index });
const call = (funcIdx: FuncHandle): Instr => ({ op: "call", funcIdx });
const i32 = (value: number): Instr => ({ op: "i32.const", value });
const f64 = (value: number): Instr => ({ op: "f64.const", value });
const empty = { kind: "empty" } as const;

/** Every field of a data descriptor present: writable, enumerable, configurable and value specified. */
const WHOLE = flags.writableSpecified | flags.enumerableSpecified | flags.configurableSpecified | flags.hasValue;

/** The RangeError unless the f64 in `local` is an array length: ToUint32(n) = n, an integer in 0 .. 2^32 - 1. */
function requireArrayLength(d: RealmArrayOperands, local: number): Instr[] {
  return [
    get(local),
    f64(0),
    { op: "f64.ge" },
    get(local),
    f64(2 ** 32),
    { op: "f64.lt" },
    { op: "i32.and" },
    get(local),
    { op: "f64.trunc" },
    get(local),
    { op: "f64.eq" },
    { op: "i32.and" },
    { op: "i32.eqz" },
    { op: "if", blockType: empty, then: d.throwRangeError("Invalid array length") },
  ];
}

/**
 * `js.object.create-array(length) -> array`: ArrayCreate (§10.4.2.2) on %Array.prototype%, a `length` that is no array
 * length throwing the RangeError (`new Array(-1)`, `new Array(1.5)`). Its own `length` {writable, !enumerable,
 * !configurable} is created before the brand, so no hook runs.
 */
export function buildArrayCreateDefinition(d: RealmArrayOperands): Definition {
  const array = 1;
  return {
    locals: [{ name: "array", type: { kind: "externref" } }],
    body: [
      ...requireArrayLength(d, 0),
      call(d.initializer),
      { op: "global.get", index: d.prototype },
      ...asOrdinaryObject(d.objectTypeIdx),
      call(d.createWithPrototype),
      tee(array),
      ...d.lengthKey,
      get(0),
      call(d.boxNumber),
      f64(flags.writable | WHOLE),
      call(d.defineDataBody),
      { op: "drop" },
      ...markObjectFlag(d.objectTypeIdx, [get(array)], flags.arrayExotic),
      get(array),
    ],
  };
}

/** The array define's parameters, then its locals. */
const L = Object.freeze({
  object: 0,
  key: 1,
  value: 2,
  getter: 3,
  setter: 4,
  word: 5,
  throwing: 6,
  obj: 7,
  lengthEntry: 8,
  index: 9,
  length: 10,
  newLength: 11,
  writable: 12,
  highest: 13,
  map: 14,
  cursor: 15,
  entry: 16,
  candidate: 17,
});

/** The number the entry in `local` holds (an array's `length`). */
const lengthOf = (d: RealmArrayOperands, local: number): Instr[] => [
  get(local),
  { op: "ref.as_non_null" },
  { op: "struct.get", typeIdx: d.entryTypeIdx, fieldIdx: PROP_ENTRY_FIELD.value },
  { op: "extern.convert_any" },
  call(d.unboxNumber),
];
const wordBits = (bits: number): Instr[] => [get(L.word), { op: "i32.trunc_f64_s" }, i32(bits), { op: "i32.and" }];
/** A rejected definition: the TypeError where the caller throws, else `false`. */
const reject = (d: RealmArrayOperands): Instr[] => [
  get(L.throwing),
  { op: "if", blockType: empty, then: d.throwTypeError("Cannot redefine property: length") },
  i32(0),
  { op: "return" },
];
/** The ordinary define of the call's own key and descriptor, data or accessor by the word's halves. */
const ordinary = (d: RealmArrayOperands): Instr[] => [
  ...wordBits(flags.getterSpecified * 3),
  {
    op: "if",
    blockType: empty,
    then: [...[L.object, L.key, L.getter, L.setter, L.word].map(get), call(d.defineAccessorBody), { op: "drop" }],
    else: [...[L.object, L.key, L.value, L.word].map(get), call(d.defineDataBody), { op: "drop" }],
  },
];
/** The ordinary define of `length` with the number `number` and the descriptor word `bits`. */
const defineLength = (d: RealmArrayOperands, number: readonly Instr[], bits: readonly Instr[]): Instr[] => [
  get(L.object),
  ...d.lengthKey,
  ...number,
  call(d.boxNumber),
  ...bits,
  call(d.defineDataBody),
  { op: "drop" },
];

/** Each live entry of the array's map whose key is an index at or above the new length, its index in `candidate`. */
function eachIndexFromNewLength(d: RealmArrayOperands, visit: readonly Instr[]): Instr[] {
  const indexed: Instr[] = [
    get(L.entry),
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: d.entryTypeIdx, fieldIdx: PROP_ENTRY_FIELD.key },
    { op: "extern.convert_any" },
    call(d.arrayIndex),
    tee(L.candidate),
    get(L.newLength),
    { op: "i64.trunc_f64_s" },
    { op: "i64.ge_s" },
    { op: "if", blockType: empty, then: [...visit] },
  ];
  return [
    get(L.obj),
    { op: "struct.get", typeIdx: d.objectTypeIdx, fieldIdx: OBJECT_FIELD.props },
    set(L.map),
    i32(0),
    set(L.cursor),
    {
      op: "block",
      blockType: empty,
      body: [
        {
          op: "loop",
          blockType: empty,
          body: [
            get(L.cursor),
            get(L.map),
            { op: "array.len" },
            { op: "i32.ge_u" },
            { op: "br_if", depth: 1 },
            get(L.map),
            get(L.cursor),
            { op: "array.get", typeIdx: d.mapTypeIdx },
            tee(L.entry),
            { op: "ref.is_null" },
            { op: "i32.eqz" },
            {
              op: "if",
              blockType: empty,
              then: [...entryFlagIs(d, L.entry, flags.tombstone, false), { op: "if", blockType: empty, then: indexed }],
            },
            get(L.cursor),
            i32(1),
            { op: "i32.add" },
            set(L.cursor),
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
  ];
}

/** ToNumber of the value into `newLength`: a number, Boolean, `null` or `undefined`; any other value aborts. */
function lengthToNumber(d: RealmArrayOperands): Instr[] {
  const value = get(L.value);
  const boolean: Instr[] = [
    value,
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: d.boxedBooleanTypeIdx },
    { op: "struct.get", typeIdx: d.boxedBooleanTypeIdx, fieldIdx: 0 },
    { op: "f64.convert_i32_u" },
    set(L.newLength),
  ];
  const undefinedOrAbort: Instr[] = [
    ...buildClosureUndefinedTest(L.value, d.anyValueTypeIdx),
    { op: "i32.eqz" },
    // A string or an object: ToNumber needs the program.
    { op: "if", blockType: empty, then: [{ op: "unreachable" }] },
    f64(NaN),
    set(L.newLength),
  ];
  return [
    value,
    call(d.isNumber),
    {
      op: "if",
      blockType: empty,
      then: [value, call(d.unboxNumber), set(L.newLength)],
      else: [
        value,
        { op: "ref.is_null" },
        {
          op: "if",
          blockType: empty,
          then: [f64(0), set(L.newLength)],
          else: [
            value,
            { op: "any.convert_extern" },
            { op: "ref.test", typeIdx: d.boxedBooleanTypeIdx },
            { op: "if", blockType: empty, then: boolean, else: undefinedOrAbort },
          ],
        },
      ],
    },
  ];
}

/**
 * §10.4.2.4 ArraySetLength, answering through `return`. Shrinking deletes the index properties at or above the new
 * length; a non-configurable one at index k stops it at k + 1 (the specification deletes from the top, so every index
 * above the highest non-configurable one goes and none below it), and the define is rejected.
 */
function arraySetLength(d: RealmArrayOperands): Instr[] {
  return [
    // No [[Value]]: the ordinary define of `length`.
    ...wordBits(flags.hasValue),
    { op: "i32.eqz" },
    { op: "if", blockType: empty, then: [...ordinary(d), i32(1), { op: "return" }] },
    ...lengthToNumber(d),
    ...requireArrayLength(d, L.newLength),
    get(L.newLength),
    ...lengthOf(d, L.lengthEntry),
    { op: "f64.ge" },
    {
      op: "if",
      blockType: empty,
      then: [...defineLength(d, [get(L.newLength)], [get(L.word)]), i32(1), { op: "return" }],
    },
    ...entryFlagIs(d, L.lengthEntry, flags.writable, false),
    { op: "if", blockType: empty, then: reject(d) },
    // A `writable: false` in the descriptor is applied after the deletions (step 12 defers it).
    ...wordBits(flags.writableSpecified | flags.writable),
    i32(flags.writableSpecified),
    { op: "i32.ne" },
    set(L.writable),
    ...defineLength(
      d,
      [get(L.newLength)],
      [get(L.word), { op: "i32.trunc_f64_s" }, i32(flags.writable), { op: "i32.or" }, { op: "f64.convert_i32_s" }],
    ),
    // The highest non-configurable index at or above the new length, else -1.
    { op: "i64.const", value: -1n },
    set(L.highest),
    ...eachIndexFromNewLength(d, [
      ...entryFlagIs(d, L.entry, flags.configurable, false),
      get(L.candidate),
      get(L.highest),
      { op: "i64.gt_s" },
      { op: "i32.and" },
      { op: "if", blockType: empty, then: [get(L.candidate), set(L.highest)] },
    ]),
    // Every index above it goes; each of them is configurable.
    ...eachIndexFromNewLength(d, [
      get(L.candidate),
      get(L.highest),
      { op: "i64.gt_s" },
      {
        op: "if",
        blockType: empty,
        then: [
          get(L.object),
          get(L.entry),
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: d.entryTypeIdx, fieldIdx: PROP_ENTRY_FIELD.key },
          { op: "extern.convert_any" },
          call(d.deleteOwn),
          { op: "drop" },
        ],
      },
    ]),
    get(L.highest),
    { op: "i64.const", value: 0n },
    { op: "i64.ge_s" },
    {
      op: "if",
      blockType: empty,
      then: [
        ...defineLength(
          d,
          [get(L.highest), { op: "f64.convert_i64_s" }, f64(1), { op: "f64.add" }],
          [
            get(L.writable),
            {
              op: "if",
              blockType: { kind: "val", type: { kind: "f64" } },
              then: [f64(flags.hasValue)],
              else: [f64(flags.hasValue | flags.writableSpecified)],
            },
          ],
        ),
        ...reject(d),
      ],
    },
    get(L.writable),
    { op: "i32.eqz" },
    { op: "if", blockType: empty, then: defineLength(d, [f64(0)], [f64(flags.writableSpecified)]) },
    i32(1),
    { op: "return" },
  ];
}

/**
 * The array define `(object, key, value, getter, setter, word, throw) -> i32` (§10.4.2.1 ArrayDefineOwnProperty; the
 * descriptor is the pack's word with its value or accessor halves). `throw` 1 throws the TypeError where the definition
 * is rejected (DefinePropertyOrThrow), 0 answers false (OrdinarySet). The ordinary defines it calls throw on their own
 * rejections, which OrdinarySet never reaches: it checked the property it updates, and no Prepared program makes an
 * object non-extensible.
 *
 * - `length` (its own entry, found as the key's): {@link arraySetLength}. ToNumber of a number, Boolean, `undefined` or
 *   `null` value is the realm's; a string or an object needs the program's ToNumber / ToPrimitive, the run-time abort.
 *   A value that is no array length throws a RangeError.
 * - an array index at or above `length`: rejected where `length` is read only, else `length` becomes index + 1.
 * - any other key: the ordinary define.
 */
export function buildArrayDefineDefinition(d: RealmArrayOperands): Definition {
  const atOrAboveLength: Instr[] = [get(L.index), { op: "f64.convert_i64_s" }, get(L.length), { op: "f64.ge" }];
  return {
    locals: [
      { name: "obj", type: { kind: "ref", typeIdx: d.objectTypeIdx } },
      { name: "lengthEntry", type: { kind: "ref_null", typeIdx: d.entryTypeIdx } },
      { name: "index", type: { kind: "i64" } },
      { name: "length", type: { kind: "f64" } },
      { name: "newLength", type: { kind: "f64" } },
      { name: "writable", type: { kind: "i32" } },
      { name: "highest", type: { kind: "i64" } },
      { name: "map", type: { kind: "ref", typeIdx: d.mapTypeIdx } },
      { name: "cursor", type: { kind: "i32" } },
      { name: "entry", type: { kind: "ref_null", typeIdx: d.entryTypeIdx } },
      { name: "candidate", type: { kind: "i64" } },
    ],
    body: [
      get(L.object),
      ...asOrdinaryObject(d.objectTypeIdx),
      set(L.obj),
      get(L.obj),
      ...d.lengthKey,
      call(d.findOwn),
      set(L.lengthEntry),
      // `length` is its own entry, so the key's entry is it exactly when the key is "length".
      get(L.obj),
      get(L.key),
      call(d.findOwn),
      get(L.lengthEntry),
      { op: "ref.eq" },
      { op: "if", blockType: empty, then: arraySetLength(d) },
      get(L.key),
      call(d.arrayIndex),
      tee(L.index),
      { op: "i64.const", value: 0n },
      { op: "i64.lt_s" },
      { op: "if", blockType: empty, then: [...ordinary(d), i32(1), { op: "return" }] },
      ...lengthOf(d, L.lengthEntry),
      set(L.length),
      ...atOrAboveLength,
      ...entryFlagIs(d, L.lengthEntry, flags.writable, false),
      { op: "i32.and" },
      { op: "if", blockType: empty, then: reject(d) },
      ...ordinary(d),
      ...atOrAboveLength,
      {
        op: "if",
        blockType: empty,
        then: [
          // The define may have grown the map, which re-creates its entries: `length`'s is found again.
          get(L.obj),
          ...d.lengthKey,
          call(d.findOwn),
          { op: "ref.as_non_null" },
          get(L.index),
          { op: "f64.convert_i64_s" },
          f64(1),
          { op: "f64.add" },
          call(d.boxNumber),
          { op: "any.convert_extern" },
          { op: "struct.set", typeIdx: d.entryTypeIdx, fieldIdx: PROP_ENTRY_FIELD.value },
        ],
      },
      i32(1),
    ],
  };
}

/** Whether the entry in `local` has (`present`) or lacks the `flag`. */
function entryFlagIs(d: RealmArrayOperands, local: number, flag: number, present: boolean): Instr[] {
  return [
    get(local),
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: d.entryTypeIdx, fieldIdx: PROP_ENTRY_FIELD.flags },
    i32(flag),
    { op: "i32.and" },
    ...(present ? [] : [{ op: "i32.eqz" } as Instr]),
  ];
}
