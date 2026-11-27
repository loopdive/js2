// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { FuncHandle, Instr, LocalDef, ValType } from "../../../wasm/model/instructions.js";
import { WRAPPER_DATA, type NativeWrapperConstructor } from "../../contracts/native-realm-catalog.js";
import {
  PRIMITIVE_WRAPPER_DATA_FIELD,
  PRIMITIVE_WRAPPER_KINDS,
  type PrimitiveWrapperKind,
} from "./primitive-wrapper-layouts.js";
import { ORDINARY_OBJECT_DESCRIPTOR_ENCODING } from "./ordinary-object-descriptor-common.js";

interface PrimitiveWrapperStorageTypes {
  readonly objectTypeIdx: number;
  readonly propMapTypeIdx: number;
  readonly wrapperTypeIdx: number;
  readonly initialCapacity: number;
  /** Exact state type and realm slot supplied by an authenticated layout owner. */
  readonly realmState?: { readonly stateTypeIdx: number; readonly realmGlobalIdx: number };
}

/** Construction data only: the caller must authenticate the issued layout owners. */
export type PrimitiveWrapperBodyBindings = PrimitiveWrapperStorageTypes &
  (
    | { readonly kind: "Boolean" | "Number" | "BigInt" }
    | { readonly kind: "String"; readonly anyStrTypeIdx: number }
    | { readonly kind: "Symbol"; readonly symbolTypeIdx: number }
  );

export interface PrimitiveWrapperBodyDefinition {
  readonly params: ValType[];
  readonly results: ValType[];
  readonly locals: LocalDef[];
  readonly body: Instr[];
}

function fail(detail: string): never {
  throw new Error("primitive wrapper body: " + detail);
}

function checkedBindings(input: PrimitiveWrapperBodyBindings) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("bindings must be a data record");
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== null && prototype !== Object.prototype) fail("bindings must be a data record");
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const value = (key: string): unknown => {
    const field = Object.hasOwn(descriptors, key) ? descriptors[key as keyof typeof descriptors] : undefined;
    if (!field || !Object.hasOwn(field, "value")) fail("missing or non-data binding " + key);
    return field.value;
  };
  const kind = value("kind");
  if (typeof kind !== "string" || !PRIMITIVE_WRAPPER_KINDS.includes(kind as PrimitiveWrapperKind))
    fail("unknown wrapper kind");
  const coordinateKeys = ["objectTypeIdx", "propMapTypeIdx", "wrapperTypeIdx"];
  if (kind === "String") coordinateKeys.push("anyStrTypeIdx");
  if (kind === "Symbol") coordinateKeys.push("symbolTypeIdx");
  const allowed = ["kind", "initialCapacity", ...coordinateKeys, "realmState"];
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string" || !allowed.includes(key)))
    fail("unknown binding");
  const coordinates = coordinateKeys.map((key) => {
    const index = value(key);
    if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0 || index > 0xffffffff)
      fail("invalid type coordinate " + key);
    return index;
  });
  if (new Set(coordinates).size !== coordinates.length) fail("aliased type coordinates");
  const initialCapacity = value("initialCapacity");
  if (
    typeof initialCapacity !== "number" ||
    !Number.isInteger(initialCapacity) ||
    initialCapacity < 1 ||
    initialCapacity > 0x40000000 ||
    (initialCapacity & (initialCapacity - 1)) !== 0
  )
    fail("initial capacity must be a positive power of two");
  const payload: ValType =
    kind === "Boolean"
      ? { kind: "i32" }
      : kind === "Number"
        ? { kind: "f64" }
        : kind === "BigInt"
          ? { kind: "externref" }
          : { kind: "ref", typeIdx: coordinates[3]! };
  let realmState: PrimitiveWrapperStorageTypes["realmState"];
  if (Object.hasOwn(descriptors, "realmState")) {
    const state = value("realmState");
    if (!state || typeof state !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(state)))
      fail("realm state must be a data record");
    const fields = Object.getOwnPropertyDescriptors(state);
    if (Reflect.ownKeys(fields).length !== 2) fail("unknown realm state binding");
    const values = ["stateTypeIdx", "realmGlobalIdx"].map((role) => {
      const field = fields[role];
      if (
        !field ||
        !Object.hasOwn(field, "value") ||
        !field.enumerable ||
        typeof field.value !== "number" ||
        !Number.isSafeInteger(field.value) ||
        field.value < 0 ||
        field.value > 0xffffffff
      )
        fail("invalid realm state coordinate");
      return field.value as number;
    });
    if (coordinates.includes(values[0]!)) fail("aliased realm state type");
    realmState = { stateTypeIdx: values[0]!, realmGlobalIdx: values[1]! };
  }
  return {
    objectTypeIdx: coordinates[0]!,
    propMapTypeIdx: coordinates[1]!,
    wrapperTypeIdx: coordinates[2]!,
    initialCapacity,
    payload,
    realmState,
  };
}

/**
 * (actual ordinary-object prototype, native payload) -> fresh wrapper externref.
 * The prototype is mandatory and nonnull; no intrinsic/default prototype is chosen.
 * String exotic behavior, payload authority and ToObject are the caller's obligations.
 * Stateful callers authenticate mixed prototype values before this storage allocation;
 * the legacy prefix holds only explicit-null own storage in that mode.
 */
export function buildPrimitiveWrapperAllocationDefinition(
  bindings: PrimitiveWrapperBodyBindings,
): PrimitiveWrapperBodyDefinition {
  const d = checkedBindings(bindings);
  return {
    params: [{ kind: "externref" }, d.payload],
    results: [{ kind: "externref" }],
    locals: [],
    body: [
      ...(d.realmState
        ? [{ op: "ref.null", typeIdx: d.objectTypeIdx } as Instr]
        : ([
            { op: "local.get", index: 0 },
            { op: "any.convert_extern" },
            { op: "ref.cast", typeIdx: d.objectTypeIdx },
          ] as Instr[])),
      { op: "i32.const", value: d.initialCapacity },
      { op: "array.new_default", typeIdx: d.propMapTypeIdx },
      { op: "i32.const", value: 0 }, // count
      { op: "i32.const", value: 0 }, // tombstones
      { op: "i32.const", value: d.realmState ? ORDINARY_OBJECT_DESCRIPTOR_ENCODING.nullPrototype : 0 },
      { op: "i32.const", value: 0 }, // nextSeq
      { op: "local.get", index: 1 },
      ...(d.realmState
        ? ([
            { op: "local.get", index: 0 },
            { op: "global.get", index: d.realmState.realmGlobalIdx },
            { op: "ref.as_non_null" },
            { op: "struct.new", typeIdx: d.realmState.stateTypeIdx },
          ] as Instr[])
        : []),
      { op: "struct.new", typeIdx: d.wrapperTypeIdx },
      { op: "extern.convert_any" },
    ],
  };
}

/** Read the immutable private slot in its exact native representation, without coercion. */
export function buildPrimitiveWrapperDataDefinition(
  bindings: PrimitiveWrapperBodyBindings,
): PrimitiveWrapperBodyDefinition {
  const d = checkedBindings(bindings);
  return {
    params: [{ kind: "externref" }],
    results: [d.payload],
    locals: [],
    body: [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: d.wrapperTypeIdx },
      { op: "struct.get", typeIdx: d.wrapperTypeIdx, fieldIdx: PRIMITIVE_WRAPPER_DATA_FIELD },
    ],
  };
}

/**
 * (#7561) How a realm represents the primitive a wrapper holds: the carrier's boxes and the native string. Each
 * kind's {@link SLOT} converts between the carrier value and the wrapper's `[[XData]]` field.
 */
export interface WrapperRepresentation {
  readonly anyStrTypeIdx: number;
  readonly boxedBooleanTypeIdx: number;
  readonly boxNumber: FuncHandle;
  readonly unboxNumber: FuncHandle;
  readonly isNumber: FuncHandle;
}
/** A wrapper kind a realm holds: its selector (`NATIVE_WRAPPER_CONSTRUCTORS` index), layout and storage bodies. */
export interface RealmWrapperKind {
  readonly kind: NativeWrapperConstructor;
  readonly selector: number;
  readonly typeIdx: number;
  /** {@link buildPrimitiveWrapperAllocationDefinition} and {@link buildPrimitiveWrapperDataDefinition} of the kind. */
  readonly allocation: FuncHandle;
  readonly read: FuncHandle;
}
type Body = { locals: LocalDef[]; body: Instr[] };
const local = (index: number): Instr => ({ op: "local.get", index });
const asAny: Instr = { op: "any.convert_extern" };
const asExtern: Instr = { op: "extern.convert_any" };

/** Each kind's field from the carrier value on the stack, back to it, and whether a carrier value is its primitive. */
const SLOT: Readonly<
  Record<
    NativeWrapperConstructor,
    Readonly<Record<"fromCarrier" | "toCarrier" | "isPrimitive", (d: WrapperRepresentation) => Instr[]>>
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
 * (#7561) A realm wrapper prototype (§22.1.3, §21.1.3, §20.3.3: a wrapper of "", +0 or false) over the `prototype`
 * the instructions leave; a string's carrier is the realm literal `text` builds.
 */
export function wrapperOfConstant(
  d: WrapperRepresentation,
  kind: RealmWrapperKind,
  primitive: string | number | boolean,
  prototype: readonly Instr[],
  text: (value: string) => Instr[],
): Instr[] {
  const carrier: Instr[] =
    typeof primitive === "string"
      ? text(primitive)
      : typeof primitive === "number"
        ? [{ op: "f64.const", value: primitive }, ...SLOT.Number.toCarrier(d)]
        : [{ op: "i32.const", value: Number(primitive) }, ...SLOT.Boolean.toCarrier(d)];
  return [...prototype, ...carrier, ...SLOT[kind.kind].fromCarrier(d), { op: "call", funcIdx: kind.allocation }];
}

export interface WrapperCreateOperands extends WrapperRepresentation {
  readonly kinds: readonly RealmWrapperKind[];
  readonly initializer: FuncHandle;
  /** Each held kind's prototype object, by selector. */
  readonly prototypes: ReadonlyMap<number, readonly Instr[]>;
  readonly defineDataBody: FuncHandle;
  readonly lengthKey: readonly Instr[];
}

/** A read-only, non-enumerable, non-configurable data property's descriptor word, every field present. */
const FIXED_DATA =
  ORDINARY_OBJECT_DESCRIPTOR_ENCODING.writableSpecified |
  ORDINARY_OBJECT_DESCRIPTOR_ENCODING.enumerableSpecified |
  ORDINARY_OBJECT_DESCRIPTOR_ENCODING.configurableSpecified |
  ORDINARY_OBJECT_DESCRIPTOR_ENCODING.hasValue;

/**
 * (#7561) `js.object.create-wrapper(primitive, selector) -> object`: §21.1.1.1 / §20.3.1.1 OrdinaryCreateFromConstructor
 * with the primitive data, and §22.1.1.1 StringCreate's own `length` {!w, !e, !c}; a String object's indices stay
 * virtual (the IR aborts an index key on one). The caller has converted the primitive.
 */
export function buildWrapperCreateDefinition(d: WrapperCreateOperands): Body {
  const wrapper = 2;
  const length: Instr[] = [
    local(wrapper),
    ...d.lengthKey,
    local(0),
    ...SLOT.String.fromCarrier(d),
    { op: "struct.get", typeIdx: d.anyStrTypeIdx, fieldIdx: 0 },
    { op: "f64.convert_i32_u" },
    { op: "call", funcIdx: d.boxNumber },
    { op: "f64.const", value: FIXED_DATA },
    { op: "call", funcIdx: d.defineDataBody },
    { op: "drop" },
  ];
  return {
    locals: [{ name: "wrapper", type: { kind: "externref" } }],
    body: [
      { op: "call", funcIdx: d.initializer },
      ...d.kinds.flatMap((kind): Instr[] => [
        local(1),
        { op: "i32.const", value: kind.selector },
        { op: "i32.eq" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            ...d.prototypes.get(kind.selector)!,
            local(0),
            ...SLOT[kind.kind].fromCarrier(d),
            { op: "call", funcIdx: kind.allocation },
            { op: "local.set", index: wrapper },
            ...(kind.kind === "String" ? length : []),
            local(wrapper),
            { op: "return" },
          ],
        },
      ]),
      { op: "unreachable" },
    ],
  };
}

/** A held kind with its prototype's `valueOf` and `toString`, in `WRAPPER_DATA` order. */
export interface RealmWrapperMethodKind extends RealmWrapperKind {
  /** Each method's function value and the TypeError of a receiver that is no such value. */
  readonly methods: readonly { readonly value: readonly Instr[]; readonly throwTypeError: readonly Instr[] }[];
}
export interface WrapperDataOperands extends WrapperRepresentation {
  /** The kinds the realm holds; with none, no wrapper exists and every answer is "no wrapper". */
  readonly kinds: readonly RealmWrapperMethodKind[];
  readonly undefinedGlobal: number;
  readonly sameValue: FuncHandle;
}

/**
 * (#7561) `js.object.wrapper-data(object, method, selector) -> value` (`WRAPPER_DATA`): for `slot`, the primitive data
 * of `object`, `undefined` for any other object; for `valueOf` / `toString`, where `method` is a held prototype's
 * method of that name, thisXValue(object) (§22.1.3.35.1, §21.1.3.7.1, §20.3.3.3.1: a primitive of the kind, a
 * wrapper's data, else the method's TypeError), and `null` for any other method. The caller answers `toString` with
 * ToString.
 */
export function buildWrapperDataDefinition(d: WrapperDataOperands): Body {
  const data = (kind: RealmWrapperKind): Instr[] => [
    local(0),
    { op: "call", funcIdx: kind.read },
    ...SLOT[kind.kind].toCarrier(d),
  ];
  const isWrapper = (kind: RealmWrapperKind): Instr[] => [local(0), asAny, { op: "ref.test", typeIdx: kind.typeIdx }];
  const answer = (test: readonly Instr[], value: readonly Instr[]): Instr[] => [
    ...test,
    { op: "if", blockType: { kind: "empty" }, then: [...value, { op: "return" }] },
  ];
  const thisValue = (kind: RealmWrapperMethodKind, method: number): Instr[] => [
    ...answer([local(0), ...SLOT[kind.kind].isPrimitive(d)], [local(0)]),
    ...answer(isWrapper(kind), data(kind)),
    ...kind.methods[method]!.throwTypeError,
  ];
  const method = (selector: number): Instr[] =>
    d.kinds.flatMap((kind) =>
      answer(
        [local(1), ...kind.methods[selector - 1]!.value, { op: "call", funcIdx: d.sameValue }],
        thisValue(kind, selector - 1),
      ),
    );
  // A method that is no held one falls through to `null`.
  const selected = (selector: number, then: Instr[]): Instr[] => [
    local(2),
    { op: "i32.const", value: selector },
    { op: "i32.eq" },
    { op: "if", blockType: { kind: "empty" }, then },
  ];
  return {
    locals: [],
    body: [
      ...selected(WRAPPER_DATA.slot, [
        ...d.kinds.flatMap((kind) => answer(isWrapper(kind), data(kind))),
        { op: "global.get", index: d.undefinedGlobal },
        asExtern,
        { op: "return" },
      ]),
      ...selected(WRAPPER_DATA.valueOf, method(WRAPPER_DATA.valueOf)),
      ...selected(WRAPPER_DATA.toString, method(WRAPPER_DATA.toString)),
      { op: "ref.null.extern" },
    ],
  };
}
