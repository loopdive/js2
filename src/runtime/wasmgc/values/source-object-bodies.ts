// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 O1) Bodies of the public source-object functions: each puts one `js.object.*` contract's signature in front
 * of the realm kernel's own algorithm, so no object algorithm is written twice. (#7368) The own-property bodies read
 * the storage pack's own-entry lookup and build a descriptor with the descriptor pack's define.
 */
import type { FuncHandle, Instr, LocalDef, TypeHandle } from "../../../wasm/model/instructions.js";
import { buildClosureUndefinedTest } from "./closure-receiver-bodies.js";
import { ORDINARY_OBJECT_DESCRIPTOR_ENCODING as ENCODING } from "./ordinary-object-descriptor-common.js";

export interface SourceObjectDefinition {
  readonly locals: LocalDef[];
  readonly body: Instr[];
}

/**
 * `js.object.create-default`: OrdinaryObjectCreate(%Object.prototype%) with an explicit link to the realm's
 * Object.prototype, so a lookup never meets the storage's implicit-prototype state.
 */
export function buildSourceObjectCreateDefinition(d: {
  readonly objectTypeIdx: TypeHandle;
  readonly objectPrototype: FuncHandle;
  readonly createWithPrototype: FuncHandle;
}): SourceObjectDefinition {
  return {
    locals: [],
    body: [
      { op: "call", funcIdx: d.objectPrototype },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: d.objectTypeIdx },
      { op: "call", funcIdx: d.createWithPrototype },
    ],
  };
}

/**
 * `js.object.get(object, key, receiver)`: the kernel's [[Get]], whose absent answer already is `undefined`. Its two
 * incomplete states (a parent outside the realm, a carrier that is not an object) cannot occur: every object a
 * source program reaches was built by `create-default` on this realm's Object.prototype.
 */
export function buildSourceObjectGetDefinition(d: { readonly get: FuncHandle }): SourceObjectDefinition {
  return {
    locals: [{ name: "value", type: { kind: "externref" } }],
    body: [
      { op: "local.get", index: 0 },
      { op: "local.get", index: 1 },
      { op: "local.get", index: 2 },
      { op: "call", funcIdx: d.get },
      { op: "local.set", index: 3 },
      { op: "i32.const", value: 2 },
      { op: "i32.ge_u" },
      { op: "if", blockType: { kind: "empty" }, then: [{ op: "unreachable" }] },
      { op: "local.get", index: 3 },
    ],
  };
}

const get = (index: number): Instr => ({ op: "local.get", index });
const EMPTY = { kind: "empty" } as const;
const I32 = { kind: "val", type: { kind: "i32" } } as const;
const EXTERN = { kind: "val", type: { kind: "externref" } } as const;
/** The `$PropEntry` fields the own-property bodies read. */
const ENTRY = { value: 1, flags: 2, get: 4, set: 5 } as const;

/** What an own-property body reads of an ordinary object and of the carrier's primitives. */
export interface SourceObjectOwnOperands {
  readonly objectTypeIdx: TypeHandle;
  readonly entryTypeIdx: TypeHandle;
  /** The storage pack's own-entry lookup: `(object, key)` to a live entry or null. */
  readonly findOwn: FuncHandle;
  /** The value packs' Number and Boolean tests (`externref` to `i32`): a wrapper of either has no own property. */
  readonly isOwnlessPrimitive: readonly FuncHandle[];
}

/**
 * `entry = OrdinaryGetOwnProperty(receiver, key)` (§10.1.5.1) into local `entry`, for a receiver that is an ordinary
 * object. A Number or Boolean answers `ownless` and returns; `nullish` runs first for `undefined` / `null`. Any other
 * carrier (a string, whose exotic object owns `length` and its indices) has no served lookup yet: a trap, never a
 * wrong answer.
 */
function ownEntry(d: SourceObjectOwnOperands, entry: number, ownless: Instr[], nullish: Instr[] = []): Instr[] {
  const receiver: Instr[] = [get(0), { op: "any.convert_extern" }];
  return [
    ...receiver,
    { op: "ref.test", typeIdx: d.objectTypeIdx },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: EMPTY,
      then: [
        ...nullish,
        ...d.isOwnlessPrimitive.flatMap((funcIdx): Instr[] => [
          get(0),
          { op: "call", funcIdx },
          { op: "if", blockType: EMPTY, then: [...ownless, { op: "return" }] },
        ]),
        { op: "unreachable" },
      ],
    },
    ...receiver,
    { op: "ref.cast", typeIdx: d.objectTypeIdx },
    get(1),
    { op: "call", funcIdx: d.findOwn },
    { op: "local.set", index: entry },
  ];
}

const entryField = (d: SourceObjectOwnOperands, entry: number, fieldIdx: number): Instr[] => [
  get(entry),
  { op: "ref.as_non_null" },
  { op: "struct.get", typeIdx: d.entryTypeIdx, fieldIdx },
];
const flagSet = (flags: Instr[], bit: number): Instr[] => [
  ...flags,
  { op: "i32.const", value: bit },
  { op: "i32.and" },
  { op: "i32.const", value: 0 },
  { op: "i32.ne" },
];

/**
 * `js.object.has-own(receiver, key)`: HasOwnProperty (§7.3.12); with `enumerable`, `js.object.property-is-enumerable`
 * (§20.1.3.4 step 4: an own property whose [[Enumerable]] is true). The caller has thrown for a nullish receiver.
 */
export function buildSourceObjectOwnTestDefinition(
  d: SourceObjectOwnOperands,
  enumerable: boolean,
): SourceObjectDefinition {
  const absent: Instr[] = [{ op: "i32.const", value: 0 }];
  return {
    locals: [{ name: "entry", type: { kind: "ref_null", typeIdx: d.entryTypeIdx } }],
    body: [
      ...ownEntry(d, 2, absent),
      get(2),
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: I32,
        then: absent,
        else: enumerable
          ? flagSet(entryField(d, 2, ENTRY.flags), ENCODING.enumerable)
          : [{ op: "i32.const", value: 1 }],
      },
    ],
  };
}

/** A data descriptor word with a value and every attribute present and true. */
const ALL_TRUE =
  ENCODING.hasValue |
  (ENCODING.writable | ENCODING.writableSpecified) |
  (ENCODING.enumerable | ENCODING.enumerableSpecified) |
  (ENCODING.configurable | ENCODING.configurableSpecified);

type DescriptorField = "value" | "writable" | "get" | "set" | "enumerable" | "configurable";

/**
 * `js.object.get-own-property(receiver, key)`: FromPropertyDescriptor (§6.2.5.4) of the receiver's own entry, or
 * `undefined` without one. The descriptor is a fresh ordinary object (`create`) whose fields the descriptor pack's
 * public define installs, in the specification's order.
 */
export function buildSourceObjectOwnDescriptorDefinition(
  d: SourceObjectOwnOperands & {
    /** A fresh ordinary object on the realm's Object.prototype. */
    readonly create: Instr[];
    readonly defineData: FuncHandle;
    readonly anyValueTypeIdx: TypeHandle;
    readonly boxedBooleanTypeIdx: TypeHandle;
    readonly undefinedValue: Instr[];
    /** ToObject's TypeError (§7.1.18), thrown. */
    readonly notCoercible: Instr[];
    readonly keys: Readonly<Record<DescriptorField, Instr[]>>;
  },
): SourceObjectDefinition {
  const [entry, descriptor, flags] = [2, 3, 4];
  const field = (name: DescriptorField, value: Instr[]): Instr[] => [
    get(descriptor),
    ...d.keys[name],
    ...value,
    { op: "f64.const", value: ALL_TRUE },
    { op: "call", funcIdx: d.defineData },
  ];
  const attribute = (bit: number): Instr[] => [
    ...flagSet([get(flags)], bit),
    { op: "struct.new", typeIdx: d.boxedBooleanTypeIdx },
    { op: "extern.convert_any" },
  ];
  // An accessor half the entry does not hold reads as `undefined`.
  const half = (fieldIdx: number): Instr[] => [
    ...entryField(d, entry, fieldIdx),
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: EXTERN,
      then: d.undefinedValue,
      else: [...entryField(d, entry, fieldIdx), { op: "extern.convert_any" }],
    },
  ];
  const nullish: Instr[] = [
    get(0),
    { op: "ref.is_null" },
    { op: "if", blockType: EMPTY, then: d.notCoercible },
    ...buildClosureUndefinedTest(0, d.anyValueTypeIdx),
    { op: "if", blockType: EMPTY, then: d.notCoercible },
  ];
  return {
    locals: [
      { name: "entry", type: { kind: "ref_null", typeIdx: d.entryTypeIdx } },
      { name: "descriptor", type: { kind: "externref" } },
      { name: "flags", type: { kind: "i32" } },
    ],
    body: [
      ...ownEntry(d, entry, d.undefinedValue, nullish),
      get(entry),
      { op: "ref.is_null" },
      { op: "if", blockType: EMPTY, then: [...d.undefinedValue, { op: "return" }] },
      ...d.create,
      { op: "local.set", index: descriptor },
      ...entryField(d, entry, ENTRY.flags),
      { op: "local.set", index: flags },
      ...flagSet([get(flags)], ENCODING.accessor),
      {
        op: "if",
        blockType: EMPTY,
        then: [...field("get", half(ENTRY.get)), ...field("set", half(ENTRY.set))],
        else: [
          ...field("value", [...entryField(d, entry, ENTRY.value), { op: "extern.convert_any" }]),
          ...field("writable", attribute(ENCODING.writable)),
        ],
      },
      ...field("enumerable", attribute(ENCODING.enumerable)),
      ...field("configurable", attribute(ENCODING.configurable)),
      get(descriptor),
    ],
  };
}
