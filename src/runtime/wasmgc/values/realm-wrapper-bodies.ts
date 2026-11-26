// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 W2) The realm's primitive wrappers: a String, Number or Boolean object is #3518's subtype of the ordinary
 * object (`primitive-wrapper-layouts.ts`), its primitive in the one slot, allocated and read by #3518's bodies
 * (`primitive-wrapper-bodies.ts`). Which wrapper an object is, is the `ref.test` of that subtype and nothing else.
 *
 * A String object's own index properties and `length` (§10.4.3) are stored when it is created, as ordinary data
 * properties with the exotic object's attributes (an index {!w, e, !c}, `length` {!w, !e, !c}) and in its key order
 * (indices ascending, then `length`): every realm lookup, define, write and key walk then answers what the String
 * exotic object answers, with no exotic [[GetOwnProperty]]. No other own property exists before these.
 */
import type { FuncHandle, Instr, LocalDef } from "../../../wasm/model/instructions.js";
import type { NativeWrapperConstructor } from "../../contracts/native-realm-catalog.js";
import { ORDINARY_OBJECT_DESCRIPTOR_ENCODING as flags } from "./ordinary-object-descriptor-common.js";

export interface RealmWrapperKind {
  readonly kind: NativeWrapperConstructor;
  /** Its `NATIVE_WRAPPER_CONSTRUCTORS` index: the selector of `js.object.create-wrapper`. */
  readonly selector: number;
  readonly typeIdx: number;
  /** #3518's `(prototype, payload) -> wrapper` and `(wrapper) -> payload`. */
  readonly allocation: FuncHandle;
  readonly read: FuncHandle;
}
export interface RealmWrapperOperands {
  readonly kinds: readonly RealmWrapperKind[];
  readonly initializer: FuncHandle;
  readonly undefinedGlobal: number;
  readonly anyStrTypeIdx: number;
  readonly nativeStrTypeIdx: number;
  readonly nativeStrDataTypeIdx: number;
  readonly boxedBooleanTypeIdx: number;
  readonly flatten: FuncHandle;
  readonly boxNumber: FuncHandle;
  readonly unboxNumber: FuncHandle;
  readonly defineDataBody: FuncHandle;
  readonly lengthKey: readonly Instr[];
}
type Definition = { locals: LocalDef[]; body: Instr[] };

const get = (index: number): Instr => ({ op: "local.get", index });
const set = (index: number): Instr => ({ op: "local.set", index });
const int = (value: number): Instr => ({ op: "i32.const", value });
const loop = (body: Instr[]): Instr => ({ op: "loop", blockType: { kind: "empty" }, body });
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

/** The kind's primitive, a carrier value on the stack, as its slot's representation. */
function wrapperPayload(d: RealmWrapperOperands, kind: NativeWrapperConstructor): Instr[] {
  if (kind === "Number") return [{ op: "call", funcIdx: d.unboxNumber }];
  const typeIdx = kind === "String" ? d.anyStrTypeIdx : d.boxedBooleanTypeIdx;
  return [
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx },
    ...(kind === "Boolean" ? [{ op: "struct.get", typeIdx, fieldIdx: 0 } as Instr] : []),
  ];
}

/** The slot's representation, on the stack, as the carrier value. */
function carrierOf(d: RealmWrapperOperands, kind: NativeWrapperConstructor): Instr[] {
  if (kind === "Number") return [{ op: "call", funcIdx: d.boxNumber }];
  return [
    ...(kind === "Boolean" ? [{ op: "struct.new", typeIdx: d.boxedBooleanTypeIdx } as Instr] : []),
    { op: "extern.convert_any" },
  ];
}

/** A native string of `length` characters of `data` from `offset`, as an externref. */
const view = (d: RealmWrapperOperands, length: Instr[], offset: Instr[], data: Instr[]): Instr[] => [
  ...length,
  ...offset,
  ...data,
  { op: "struct.new", typeIdx: d.nativeStrTypeIdx },
  { op: "extern.convert_any" },
];

/**
 * The canonical decimal key of the local `index` (§7.1.21 CanonicalNumericIndexString's inverse for an array index)
 * into the local `chars`, a fresh character array; `n` and `digits` are scratch.
 */
function indexKey(d: RealmWrapperOperands, index: number, chars: number, n: number, digits: number): Instr[] {
  return [
    int(1),
    set(digits),
    get(index),
    set(n),
    loop([
      get(n),
      int(9),
      { op: "i32.gt_u" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          get(n),
          int(10),
          { op: "i32.div_u" },
          set(n),
          get(digits),
          int(1),
          { op: "i32.add" },
          set(digits),
          { op: "br", depth: 1 },
        ],
      },
    ]),
    get(digits),
    { op: "array.new_default", typeIdx: d.nativeStrDataTypeIdx },
    set(chars),
    get(index),
    set(n),
    loop([
      get(digits),
      int(1),
      { op: "i32.sub" },
      set(digits),
      get(chars),
      get(digits),
      get(n),
      int(10),
      { op: "i32.rem_u" },
      int(48),
      { op: "i32.add" },
      { op: "array.set", typeIdx: d.nativeStrDataTypeIdx },
      get(n),
      int(10),
      { op: "i32.div_u" },
      set(n),
      get(digits),
      { op: "br_if", depth: 0 },
    ]),
  ];
}

/** The String object in `wrapper`: its own index properties, then `length`, from the string in local 0. */
function stringOwnProperties(d: RealmWrapperOperands, wrapper: number, first: number): Instr[] {
  const [flat, index, length, chars, n, digits] = [first, first + 1, first + 2, first + 3, first + 4, first + 5];
  const define = (key: Instr[], value: Instr[], enumerable: boolean): Instr[] => [
    get(wrapper),
    ...key,
    ...value,
    word(enumerable),
    { op: "call", funcIdx: d.defineDataBody },
    { op: "drop" },
  ];
  const field = (fieldIdx: number): Instr[] => [get(flat), { op: "struct.get", typeIdx: d.nativeStrTypeIdx, fieldIdx }];
  return [
    get(0),
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: d.anyStrTypeIdx },
    { op: "call", funcIdx: d.flatten },
    set(flat),
    ...field(0),
    set(length),
    int(0),
    set(index),
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        loop([
          get(index),
          get(length),
          { op: "i32.ge_u" },
          { op: "br_if", depth: 1 },
          ...indexKey(d, index, chars, n, digits),
          ...define(
            view(d, [get(chars), { op: "array.len" }], [int(0)], [get(chars)]),
            view(d, [int(1)], [...field(1), get(index), { op: "i32.add" }], field(2)),
            true,
          ),
          get(index),
          int(1),
          { op: "i32.add" },
          set(index),
          { op: "br", depth: 0 },
        ]),
      ],
    },
    ...define(
      [...d.lengthKey],
      [get(length), { op: "f64.convert_i32_u" }, { op: "call", funcIdx: d.boxNumber }],
      false,
    ),
  ];
}

/** The locals {@link stringOwnProperties} uses after the wrapper's. */
const stringLocals = (d: RealmWrapperOperands): LocalDef[] => [
  { name: "flat", type: { kind: "ref_null", typeIdx: d.nativeStrTypeIdx } },
  ...["index", "length"].map((name): LocalDef => ({ name, type: { kind: "i32" } })),
  { name: "chars", type: { kind: "ref_null", typeIdx: d.nativeStrDataTypeIdx } },
  ...["n", "digits"].map((name): LocalDef => ({ name, type: { kind: "i32" } })),
];

/**
 * A new wrapper of the kind `selector` with [[Prototype]] `prototype` (an externref on the stack) and the primitive in
 * local 0: the allocation, then a String's own properties. The wrapper is left in local `wrapper`.
 */
function allocate(d: RealmWrapperOperands, kind: RealmWrapperKind, prototype: Instr[], wrapper: number): Instr[] {
  return [
    ...prototype,
    get(0),
    ...wrapperPayload(d, kind.kind),
    { op: "call", funcIdx: kind.allocation },
    set(wrapper),
    ...(kind.kind === "String" ? stringOwnProperties(d, wrapper, wrapper + 1) : []),
  ];
}

/**
 * `js.object.create-wrapper(primitive, selector) -> object` (§22.1.1.1 StringCreate, §21.1.1.1 / §20.3.1.1
 * OrdinaryCreateFromConstructor with the slot): the caller has converted the primitive (ToString, ToNumber, ToBoolean)
 * and passes the kind's prototype in `prototypes`, by selector.
 */
export function buildWrapperCreateDefinition(
  d: RealmWrapperOperands,
  prototypes: ReadonlyMap<number, readonly Instr[]>,
): Definition {
  const wrapper = 2;
  return {
    locals: [{ name: "wrapper", type: { kind: "externref" } }, ...stringLocals(d)],
    body: [
      { op: "call", funcIdx: d.initializer },
      ...d.kinds.flatMap((kind): Instr[] => [
        get(1),
        int(kind.selector),
        { op: "i32.eq" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [...allocate(d, kind, [...prototypes.get(kind.selector)!], wrapper), get(wrapper), { op: "return" }],
        },
      ]),
      { op: "unreachable" },
    ],
  };
}

/**
 * `js.object.primitive-data(object) -> value`: the [[StringData]] / [[NumberData]] / [[BooleanData]] of a wrapper as
 * the primitive value, `undefined` for any other object (no wrapper holds `undefined`).
 */
export function buildPrimitiveDataDefinition(d: RealmWrapperOperands): Definition {
  return {
    locals: [],
    body: [
      ...d.kinds.flatMap((kind): Instr[] => [
        get(0),
        { op: "any.convert_extern" },
        { op: "ref.test", typeIdx: kind.typeIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [get(0), { op: "call", funcIdx: kind.read }, ...carrierOf(d, kind.kind), { op: "return" }],
        },
      ]),
      { op: "global.get", index: d.undefinedGlobal },
      { op: "extern.convert_any" },
    ],
  };
}

/** A held wrapper prototype's `valueOf` or `toString`: its function value and its wrong-receiver TypeError. */
export interface RealmWrapperMethod {
  readonly kind: RealmWrapperKind;
  readonly method: "valueOf" | "toString";
  /** The method's function object, as an externref (initializing the realm). */
  readonly value: readonly Instr[];
  /** Throws the TypeError of a receiver that is no value of the kind. */
  readonly throwTypeError: readonly Instr[];
}
export interface RealmWrapperMethodOperands extends RealmWrapperOperands {
  readonly methods: readonly RealmWrapperMethod[];
  readonly sameValue: FuncHandle;
  readonly isNumber: FuncHandle;
}

/** Whether the carrier value in `local` is a primitive of `kind`. */
function isPrimitiveOf(d: RealmWrapperMethodOperands, kind: NativeWrapperConstructor, local: number): Instr[] {
  if (kind === "Number") return [get(local), { op: "call", funcIdx: d.isNumber }];
  return [
    get(local),
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: kind === "String" ? d.anyStrTypeIdx : d.boxedBooleanTypeIdx },
  ];
}

/**
 * `js.object.wrapper-this(method, this) -> value`: where `method` is a held wrapper prototype's `valueOf` or
 * `toString`, thisXValue(this) (§22.1.3.35.1 thisStringValue, §21.1.3.7.1, §20.3.3.3.1): a primitive of the kind
 * itself, a wrapper's slot, else the method's TypeError; `null` for any other method (no primitive is null). The
 * caller answers `valueOf` with it and `toString` with its ToString (`js.object.wrapper-to-string`).
 */
export function buildWrapperThisDefinition(d: RealmWrapperMethodOperands): Definition {
  const answer = (row: RealmWrapperMethod): Instr[] => [
    ...isPrimitiveOf(d, row.kind.kind, 1),
    { op: "if", blockType: { kind: "empty" }, then: [get(1), { op: "return" }] },
    get(1),
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: row.kind.typeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [get(1), { op: "call", funcIdx: row.kind.read }, ...carrierOf(d, row.kind.kind), { op: "return" }],
    },
    ...row.throwTypeError,
  ];
  return {
    locals: [],
    body: [
      ...d.methods.flatMap((row): Instr[] => [
        get(0),
        ...row.value,
        { op: "call", funcIdx: d.sameValue },
        { op: "if", blockType: { kind: "empty" }, then: answer(row) },
      ]),
      { op: "ref.null.extern" },
    ],
  };
}

/** `js.object.wrapper-to-string(method) -> i32`: whether `method` is a held wrapper prototype's `toString`. */
export function buildWrapperToStringDefinition(d: RealmWrapperMethodOperands): Definition {
  return {
    locals: [],
    body: [
      int(0),
      ...d.methods
        .filter((row) => row.method === "toString")
        .flatMap((row): Instr[] => [get(0), ...row.value, { op: "call", funcIdx: d.sameValue }, { op: "i32.or" }]),
    ],
  };
}
