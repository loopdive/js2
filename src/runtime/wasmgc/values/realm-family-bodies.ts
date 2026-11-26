// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 G1) The kernel's part of an intrinsic family the realm holds (the Error family): its ordinary objects (the
 * prototypes), created when the realm initializes; the catalog's own properties of its members and objects; and the
 * creation of an error, which the realm's own TypeError and a program's `new X(m)` share.
 *
 * An error is an ordinary object of the realm: [[Prototype]] its constructor's prototype, an own non-enumerable
 * `message` when one was given (§20.5.1.1 step 3), and the [[ErrorData]] bit of the object's flags, which only
 * `Object.prototype.toString` reads (§20.1.3.6 step 9).
 */
import type { FuncHandle, Instr, LocalDef } from "../../../wasm/model/instructions.js";
import { REALM_BRAND, type NativeRealmPrimitive } from "../../contracts/native-realm-catalog.js";
import { CLOSURE_BAG_FIELD_IDX } from "./closure-layouts.js";
import { ORDINARY_OBJECT_DESCRIPTOR_ENCODING as flags } from "./ordinary-object-descriptor-common.js";
import { kernelGetInto } from "./kernel-get-body.js";
import { markArray } from "./realm-array-bodies.js";

/** A family property: a string, (#7354 W2) a number, or a realm entry or object by catalog id. */
export interface RealmFamilyProperty {
  readonly key: string;
  readonly value:
    | { readonly kind: "string"; readonly value: string }
    | { readonly kind: "number"; readonly value: number }
    | { readonly kind: "intrinsic"; readonly id: string };
  readonly writable: boolean;
  readonly configurable: boolean;
}
export interface RealmFamilyOperands {
  readonly objectTypeIdx: number;
  /** The global holding the realm's Object.prototype. */
  readonly objectPrototype: number;
  readonly createWithPrototype: FuncHandle;
  readonly defineDataBody: FuncHandle;
  readonly boxNumber: FuncHandle;
  /** A realm string literal as an externref. */
  readonly text: (value: string) => Instr[];
  readonly entries: readonly {
    readonly id: string;
    readonly typeIdx: number;
    readonly singleton: number;
    readonly properties: readonly RealmFamilyProperty[];
  }[];
  /** The family's ordinary objects, each after the one it links to (`object-prototype`: the realm's). */
  readonly objects: readonly {
    readonly id: string;
    readonly global: number;
    readonly prototype: string;
    /** (#7354 W2) A wrapper prototype's primitive slot. */
    readonly primitive?: NativeRealmPrimitive;
    /** (#7354 A1) %Array.prototype%, itself an array. */
    readonly array?: true;
    readonly properties: readonly RealmFamilyProperty[];
  }[];
  /** (#7354 W2) Where the realm holds wrappers: the wrapper of `primitive` with the prototype `prototype` leaves. */
  readonly wrapperAllocation?: (primitive: NativeRealmPrimitive, prototype: readonly Instr[]) => Instr[];
}

const global = (index: number): Instr => ({ op: "global.get", index });
const asObject = (d: Pick<RealmFamilyOperands, "objectTypeIdx">): Instr[] => [
  { op: "any.convert_extern" },
  { op: "ref.cast", typeIdx: d.objectTypeIdx },
];

/** The externref of the realm's entry or object `id` ((#7354 W2) its Object.prototype too). */
function intrinsic(d: RealmFamilyOperands, id: string): Instr[] {
  if (id === "%Object.prototype%") return [global(d.objectPrototype)];
  const object = d.objects.find((row) => row.id === id);
  if (object) return [global(object.global)];
  const entry = d.entries.find((row) => row.id === id);
  if (!entry) throw new Error(`realm family: no entry or object ${id}`);
  return [global(entry.singleton), { op: "ref.as_non_null" }, { op: "extern.convert_any" }];
}

/** A non-enumerable data property's whole descriptor word, every field present. */
const word = (property: Pick<RealmFamilyProperty, "writable" | "configurable">): number =>
  (property.writable ? flags.writable : 0) |
  (property.configurable ? flags.configurable : 0) |
  flags.writableSpecified |
  flags.enumerableSpecified |
  flags.configurableSpecified |
  flags.hasValue;

/** Each object, linked to the realm's Object.prototype or to an object created before it, into its global. */
export function realmFamilyAllocation(d: RealmFamilyOperands): Instr[] {
  return d.objects.flatMap((object): Instr[] => {
    const prototype =
      object.prototype === "object-prototype" ? [global(d.objectPrototype)] : intrinsic(d, object.prototype);
    const created = object.primitive
      ? d.wrapperAllocation!(object.primitive, prototype)
      : [...prototype, ...asObject(d), { op: "call", funcIdx: d.createWithPrototype } as Instr];
    return [
      ...created,
      { op: "global.set", index: object.global },
      ...(object.array ? markArray(d.objectTypeIdx, [global(object.global)]) : []),
    ];
  });
}

/** A property's value as an externref. */
function propertyValue(d: RealmFamilyOperands, value: RealmFamilyProperty["value"]): Instr[] {
  if (value.kind === "string") return d.text(value.value);
  if (value.kind === "number")
    return [
      { op: "f64.const", value: value.value },
      { op: "call", funcIdx: d.boxNumber },
    ];
  return intrinsic(d, value.id);
}

/** Define `property` on the storage `target` leaves. */
function define(d: RealmFamilyOperands, target: readonly Instr[], property: RealmFamilyProperty): Instr[] {
  return [
    ...target,
    ...d.text(property.key),
    ...propertyValue(d, property.value),
    { op: "f64.const", value: word(property) },
    { op: "call", funcIdx: d.defineDataBody },
    { op: "drop" },
  ];
}

/** The members' own properties (on their bags), then the objects'. */
export function realmFamilySeed(d: RealmFamilyOperands): Instr[] {
  const bag = (entry: RealmFamilyOperands["entries"][number]): Instr[] => [
    global(entry.singleton),
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: entry.typeIdx, fieldIdx: CLOSURE_BAG_FIELD_IDX },
  ];
  return [
    ...d.entries.flatMap((entry) => entry.properties.flatMap((property) => define(d, bag(entry), property))),
    ...d.objects.flatMap((object) =>
      object.properties.flatMap((property) => define(d, [global(object.global)], property)),
    ),
  ];
}

export interface ErrorCreateOperands extends RealmFamilyOperands {
  readonly initializer: FuncHandle;
  /** Each held constructor's prototype object, by its selector (`NATIVE_ERROR_CONSTRUCTORS` order). */
  readonly prototypes: readonly { readonly selector: number; readonly global: number }[];
}

/**
 * `(message, selector) -> error`: OrdinaryCreateFromConstructor with the prototype of the constructor `selector`
 * (its `prototype` is read only and non-configurable, so it is that object), the [[ErrorData]] bit, and an own
 * `message` {writable, !enumerable, configurable} unless `message` is null (none was given). The caller has done
 * ToString.
 */
export function buildErrorCreateDefinition(d: ErrorCreateOperands): { locals: LocalDef[]; body: Instr[] } {
  const error = 2;
  const flagsField = 4;
  return {
    locals: [{ name: "error", type: { kind: "externref" } }],
    body: [
      { op: "call", funcIdx: d.initializer },
      ...d.prototypes.flatMap(({ selector, global: prototype }): Instr[] => [
        { op: "local.get", index: 1 },
        { op: "i32.const", value: selector },
        { op: "i32.eq" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            global(prototype),
            ...asObject(d),
            { op: "call", funcIdx: d.createWithPrototype },
            { op: "local.set", index: error },
          ],
        },
      ]),
      { op: "local.get", index: error },
      ...asObject(d),
      { op: "local.get", index: error },
      ...asObject(d),
      { op: "struct.get", typeIdx: d.objectTypeIdx, fieldIdx: flagsField },
      { op: "i32.const", value: flags.errorData },
      { op: "i32.or" },
      { op: "struct.set", typeIdx: d.objectTypeIdx, fieldIdx: flagsField },
      { op: "local.get", index: 0 },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "empty" },
        else: [
          { op: "local.get", index: error },
          ...d.text("message"),
          { op: "local.get", index: 0 },
          { op: "f64.const", value: word({ writable: true, configurable: true }) },
          { op: "call", funcIdx: d.defineDataBody },
          { op: "drop" },
        ],
        then: [],
      },
      { op: "local.get", index: error },
    ],
  };
}

/**
 * `js.object.has-brand(object, selector) -> i32`: the realm brand `selector` (`REALM_BRAND`: [[ErrorData]], (#7354 A1)
 * the Array exotic object) in an ordinary object's flags (the caller tests the kind).
 */
export function buildHasBrandDefinition(d: { readonly objectTypeIdx: number }): { locals: LocalDef[]; body: Instr[] } {
  return {
    locals: [],
    body: [
      { op: "local.get", index: 0 },
      ...asObject(d),
      { op: "struct.get", typeIdx: d.objectTypeIdx, fieldIdx: 4 },
      { op: "local.get", index: 1 },
      { op: "i32.const", value: REALM_BRAND.array },
      { op: "i32.eq" },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [{ op: "i32.const", value: flags.arrayExotic }],
        else: [{ op: "i32.const", value: flags.errorData }],
      },
      { op: "i32.and" },
      { op: "i32.const", value: 0 },
      { op: "i32.ne" },
    ],
  };
}

export interface ErrorToStringOperands {
  /** The kernel's [[Get]] `(object, key, receiver) -> (status, value)`. */
  readonly get: FuncHandle;
  readonly undefinedGlobal: number;
  readonly anyValueTypeIdx: number;
  readonly anyStrTypeIdx: number;
  readonly consStrTypeIdx: number;
  readonly text: (value: string) => Instr[];
}

/**
 * `js.object.error-to-string(object) -> string` (§20.5.3.4; the caller passes an object): `name` (undefined →
 * "Error") and `message` (undefined → ""), then the name alone, the message alone, or `name + ": " + message`.
 * ToString of a `name` or `message` that is neither a string nor undefined (a program wrote one) is the run-time abort:
 * the realm has no ToString of a number or an object, and a wrong text is never an answer.
 */
export function buildErrorToStringDefinition(d: ErrorToStringOperands): { locals: LocalDef[]; body: Instr[] } {
  const [name, message] = [1, 2];
  const string = (local: number): Instr[] => [
    { op: "local.get", index: local },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: d.anyStrTypeIdx },
  ];
  const length = (local: number): Instr[] => [
    ...string(local),
    { op: "struct.get", typeIdx: d.anyStrTypeIdx, fieldIdx: 0 },
  ];
  const isUndefined = (local: number): Instr[] => [
    { op: "local.get", index: local },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: d.anyValueTypeIdx },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [
        { op: "local.get", index: local },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: d.anyValueTypeIdx },
        global(d.undefinedGlobal),
        { op: "ref.eq" },
      ],
      else: [{ op: "i32.const", value: 0 }],
    },
  ];
  const part = (key: string, local: number, absent: string): Instr[] => [
    ...kernelGetInto(d.get, [{ op: "local.get", index: 0 }, ...d.text(key), { op: "local.get", index: 0 }], local),
    ...isUndefined(local),
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [...d.text(absent), { op: "local.set", index: local }],
      else: [
        { op: "local.get", index: local },
        { op: "any.convert_extern" },
        { op: "ref.test", typeIdx: d.anyStrTypeIdx },
        { op: "i32.eqz" },
        { op: "if", blockType: { kind: "empty" }, then: [{ op: "unreachable" }] },
      ],
    },
  ];
  const returnIfEmpty = (local: number, other: number): Instr[] => [
    ...length(local),
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: [{ op: "local.get", index: other }, { op: "return" }] },
  ];
  const separator: Instr[] = [
    ...d.text(": "),
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: d.anyStrTypeIdx },
  ];
  return {
    locals: [
      { name: "name", type: { kind: "externref" } },
      { name: "message", type: { kind: "externref" } },
    ],
    body: [
      ...part("name", name, "Error"),
      ...part("message", message, ""),
      ...returnIfEmpty(name, message),
      ...returnIfEmpty(message, name),
      // (name + ": ") + message, as two ropes: their lengths are the parts' sums.
      ...length(name),
      { op: "i32.const", value: 2 },
      { op: "i32.add" },
      ...length(message),
      { op: "i32.add" },
      ...length(name),
      { op: "i32.const", value: 2 },
      { op: "i32.add" },
      ...string(name),
      ...separator,
      { op: "struct.new", typeIdx: d.consStrTypeIdx },
      ...string(message),
      { op: "struct.new", typeIdx: d.consStrTypeIdx },
      { op: "extern.convert_any" },
    ],
  };
}
