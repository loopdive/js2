// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 W2) The realm's primitive wrappers: a String, Number or Boolean object is #3518's subtype of the ordinary
 * object (`primitive-wrapper-layouts.ts`), its primitive in the one slot, allocated and read by #3518's bodies
 * (`primitive-wrapper-bodies.ts`). Which wrapper an object is, is the `ref.test` of that subtype and nothing else; how
 * each kind's slot holds its primitive is {@link SLOT}, the one place that says it.
 *
 * A String object's own index properties and `length` (§10.4.3) are stored when it is created, as ordinary data
 * properties with the exotic object's attributes (an index {!w, e, !c}, `length` {!w, !e, !c}) and in its key order
 * (indices ascending, then `length`): every realm lookup, define, write and key walk then answers what the String
 * exotic object answers, with no exotic [[GetOwnProperty]]. No other own property exists before these.
 */
import type { FuncHandle, Instr, LocalDef } from "../../../wasm/model/instructions.js";
import {
  WRAPPER_DATA,
  type NativeRealmPrimitive,
  type NativeWrapperConstructor,
} from "../../contracts/native-realm-catalog.js";
import { ORDINARY_OBJECT_DESCRIPTOR_ENCODING as flags } from "./ordinary-object-descriptor-common.js";

/** How the realm represents a primitive: the carrier's boxes and the native string. */
export interface WrapperRepresentation {
  readonly anyStrTypeIdx: number;
  readonly boxedBooleanTypeIdx: number;
  readonly boxNumber: FuncHandle;
  readonly unboxNumber: FuncHandle;
  readonly isNumber: FuncHandle;
}
export interface RealmWrapperKind {
  readonly kind: NativeWrapperConstructor;
  /** Its `NATIVE_WRAPPER_CONSTRUCTORS` index: the selector of `js.object.create-wrapper`. */
  readonly selector: number;
  readonly typeIdx: number;
  /** #3518's `(prototype, payload) -> wrapper` and `(wrapper) -> payload`. */
  readonly allocation: FuncHandle;
  readonly read: FuncHandle;
}
/** A held kind with its prototype's `valueOf` and `toString` (`WRAPPER_DATA` order after the slot). */
export interface RealmWrapperMethodKind extends RealmWrapperKind {
  /** Each method's function value (initializing the realm) and the TypeError of a receiver that is no such value. */
  readonly methods: readonly { readonly value: readonly Instr[]; readonly throwTypeError: readonly Instr[] }[];
}
export interface RealmWrapperDataOperands extends WrapperRepresentation {
  /** The kinds the realm holds (none: no wrapper exists, and every answer is "no wrapper"). */
  readonly kinds: readonly RealmWrapperMethodKind[];
  readonly undefinedGlobal: number;
  readonly sameValue: FuncHandle;
}
export interface RealmWrapperCreateOperands extends WrapperRepresentation {
  readonly kinds: readonly RealmWrapperKind[];
  readonly initializer: FuncHandle;
  readonly nativeStrTypeIdx: number;
  readonly flatten: FuncHandle;
  /** `(index) -> key`: the canonical decimal key of an array index (`string-index-key-body.ts`). */
  readonly indexKey: FuncHandle;
  readonly defineDataBody: FuncHandle;
  readonly lengthKey: readonly Instr[];
}
type Definition = { locals: LocalDef[]; body: Instr[] };

const get = (index: number): Instr => ({ op: "local.get", index });
const set = (index: number): Instr => ({ op: "local.set", index });
const int = (value: number): Instr => ({ op: "i32.const", value });
const asAny: Instr = { op: "any.convert_extern" };
const asExtern: Instr = { op: "extern.convert_any" };

/**
 * Each kind's slot: from the carrier value on the stack, back to it, a constant, and whether a carrier value is a
 * primitive of the kind.
 */
const SLOT: Readonly<
  Record<
    NativeWrapperConstructor,
    {
      readonly fromCarrier: (d: WrapperRepresentation) => Instr[];
      readonly toCarrier: (d: WrapperRepresentation) => Instr[];
      readonly isPrimitive: (d: WrapperRepresentation) => Instr[];
    }
  >
> = {
  String: {
    fromCarrier: (d) => [asAny, { op: "ref.cast", typeIdx: d.anyStrTypeIdx }],
    toCarrier: () => [asExtern],
    isPrimitive: (d) => [asAny, { op: "ref.test", typeIdx: d.anyStrTypeIdx }],
  },
  Number: {
    fromCarrier: (d) => [{ op: "call", funcIdx: d.unboxNumber }],
    toCarrier: (d) => [{ op: "call", funcIdx: d.boxNumber }],
    isPrimitive: (d) => [{ op: "call", funcIdx: d.isNumber }],
  },
  Boolean: {
    fromCarrier: (d) => [
      asAny,
      { op: "ref.cast", typeIdx: d.boxedBooleanTypeIdx },
      { op: "struct.get", typeIdx: d.boxedBooleanTypeIdx, fieldIdx: 0 },
    ],
    toCarrier: (d) => [{ op: "struct.new", typeIdx: d.boxedBooleanTypeIdx }, asExtern],
    isPrimitive: (d) => [asAny, { op: "ref.test", typeIdx: d.boxedBooleanTypeIdx }],
  },
};

/**
 * (The initializer's part) A wrapper prototype (`String.prototype` is a String object for "", §22.1.3): the wrapper of
 * the catalog's constant `primitive`, whose carrier `text` builds for a string, over `prototype`.
 */
export function wrapperOfConstant(
  d: WrapperRepresentation,
  kind: NativeWrapperConstructor,
  allocation: FuncHandle,
  primitive: NativeRealmPrimitive,
  prototype: readonly Instr[],
  text: (value: string) => Instr[],
): Instr[] {
  const carrier: Instr[] =
    primitive.kind === "string"
      ? text(primitive.value)
      : primitive.kind === "number"
        ? [{ op: "f64.const", value: primitive.value }, ...SLOT.Number.toCarrier(d)]
        : [int(Number(primitive.value)), ...SLOT.Boolean.toCarrier(d)];
  return [...prototype, ...carrier, ...SLOT[kind].fromCarrier(d), { op: "call", funcIdx: allocation }];
}

/** A read-only, non-configurable data property's descriptor word, every field present. */
const word = (enumerable: boolean): Instr => ({
  op: "f64.const",
  value:
    (enumerable ? flags.enumerable : 0) |
    flags.writableSpecified |
    flags.enumerableSpecified |
    flags.configurableSpecified |
    flags.hasValue,
});

/** The String object in `wrapper`: its own index properties, then `length`, from the string in local 0. */
function stringOwnProperties(d: RealmWrapperCreateOperands, wrapper: number, first: number): Instr[] {
  const [flat, index, length] = [first, first + 1, first + 2];
  const define = (key: Instr[], value: Instr[], enumerable: boolean): Instr[] => [
    get(wrapper),
    ...key,
    ...value,
    word(enumerable),
    { op: "call", funcIdx: d.defineDataBody },
    { op: "drop" },
  ];
  const field = (fieldIdx: number): Instr[] => [get(flat), { op: "struct.get", typeIdx: d.nativeStrTypeIdx, fieldIdx }];
  // The index-th character: a length-one view of the flat string.
  const character: Instr[] = [
    int(1),
    ...field(1),
    get(index),
    { op: "i32.add" },
    ...field(2),
    { op: "struct.new", typeIdx: d.nativeStrTypeIdx },
    asExtern,
  ];
  return [
    get(0),
    ...SLOT.String.fromCarrier(d),
    { op: "call", funcIdx: d.flatten },
    set(flat),
    ...field(0),
    set(length),
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            get(index),
            get(length),
            { op: "i32.ge_u" },
            { op: "br_if", depth: 1 },
            ...define([get(index), { op: "call", funcIdx: d.indexKey }], character, true),
            get(index),
            int(1),
            { op: "i32.add" },
            set(index),
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    ...define([...d.lengthKey], [get(length), { op: "f64.convert_i32_u" }, ...SLOT.Number.toCarrier(d)], false),
  ];
}

/**
 * `js.object.create-wrapper(primitive, selector) -> object` (§22.1.1.1 StringCreate, §21.1.1.1 / §20.3.1.1
 * OrdinaryCreateFromConstructor with the slot): the caller has converted the primitive (ToString, ToNumber, ToBoolean);
 * `prototypes` holds each held kind's prototype, by selector.
 */
export function buildWrapperCreateDefinition(
  d: RealmWrapperCreateOperands,
  prototypes: ReadonlyMap<number, readonly Instr[]>,
): Definition {
  const wrapper = 2;
  return {
    locals: [
      { name: "wrapper", type: { kind: "externref" } },
      { name: "flat", type: { kind: "ref_null", typeIdx: d.nativeStrTypeIdx } },
      { name: "index", type: { kind: "i32" } },
      { name: "length", type: { kind: "i32" } },
    ],
    body: [
      { op: "call", funcIdx: d.initializer },
      ...d.kinds.flatMap((kind): Instr[] => [
        get(1),
        int(kind.selector),
        { op: "i32.eq" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            ...prototypes.get(kind.selector)!,
            get(0),
            ...SLOT[kind.kind].fromCarrier(d),
            { op: "call", funcIdx: kind.allocation },
            set(wrapper),
            ...(kind.kind === "String" ? stringOwnProperties(d, wrapper, wrapper + 1) : []),
            get(wrapper),
            { op: "return" },
          ],
        },
      ]),
      { op: "unreachable" },
    ],
  };
}

/**
 * `js.object.wrapper-data(object, method, selector) -> value`, a wrapper's slot as the realm answers it:
 *
 * - `slot`: the [[StringData]] / [[NumberData]] / [[BooleanData]] of `object` as the primitive value, `undefined` for
 *   any other object (no wrapper holds `undefined`); `method` is unread.
 * - `valueOf` / `toString`: where `method` is a held wrapper prototype's method of that name, thisXValue(object)
 *   (§22.1.3.35.1 thisStringValue, §21.1.3.7.1, §20.3.3.3.1: a primitive of the kind itself, a wrapper's slot, else the
 *   method's TypeError), and `null` for any other method (no primitive is null). The caller answers `toString` with
 *   ToString of it.
 */
export function buildWrapperDataDefinition(d: RealmWrapperDataOperands): Definition {
  const slotOf = (kind: RealmWrapperMethodKind): Instr[] => [
    get(0),
    { op: "call", funcIdx: kind.read },
    ...SLOT[kind.kind].toCarrier(d),
  ];
  const isWrapper = (kind: RealmWrapperMethodKind): Instr[] => [
    get(0),
    asAny,
    { op: "ref.test", typeIdx: kind.typeIdx },
  ];
  const slot: Instr[] = [
    ...d.kinds.flatMap((kind): Instr[] => [
      ...isWrapper(kind),
      { op: "if", blockType: { kind: "empty" }, then: [...slotOf(kind), { op: "return" }] },
    ]),
    { op: "global.get", index: d.undefinedGlobal },
    asExtern,
    { op: "return" },
  ];
  const thisValue = (kind: RealmWrapperMethodKind, method: number): Instr[] => [
    get(0),
    ...SLOT[kind.kind].isPrimitive(d),
    { op: "if", blockType: { kind: "empty" }, then: [get(0), { op: "return" }] },
    ...isWrapper(kind),
    { op: "if", blockType: { kind: "empty" }, then: [...slotOf(kind), { op: "return" }] },
    ...kind.methods[method]!.throwTypeError,
  ];
  const method = (selector: number): Instr[] =>
    d.kinds.flatMap((kind): Instr[] => [
      get(1),
      ...kind.methods[selector - 1]!.value,
      { op: "call", funcIdx: d.sameValue },
      { op: "if", blockType: { kind: "empty" }, then: thisValue(kind, selector - 1) },
    ]);
  return {
    locals: [],
    body: [
      get(2),
      int(WRAPPER_DATA.slot),
      { op: "i32.eq" },
      { op: "if", blockType: { kind: "empty" }, then: slot },
      get(2),
      int(WRAPPER_DATA.valueOf),
      { op: "i32.eq" },
      { op: "if", blockType: { kind: "empty" }, then: method(WRAPPER_DATA.valueOf) },
      get(2),
      int(WRAPPER_DATA.toString),
      { op: "i32.eq" },
      { op: "if", blockType: { kind: "empty" }, then: method(WRAPPER_DATA.toString) },
      { op: "ref.null.extern" },
    ],
  };
}
