// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr, LocalDef, FuncHandle } from "../../../wasm/model/instructions.js";
import {
  BFN_ID_FIELD_IDX,
  CLOSURE_ARITY_FIELD_IDX,
  CLOSURE_BAG_FIELD_IDX,
  CLOSURE_FUNC_FIELD_IDX,
} from "./closure-layouts.js";
import { ORDINARY_OBJECT_DESCRIPTOR_ENCODING } from "./ordinary-object-descriptor-common.js";
import {
  BUILTIN_FUNCTION_REALM_FIELD,
  BUILTIN_FUNCTION_PROTOTYPE_FIELD,
  BUILTIN_FUNCTION_INITIAL_NAME_FIELD,
  BUILTIN_IDENTITY_ONLY_FLAG,
  OPEN_OBJECT_FLAGS_FIELD,
} from "./builtin-function-layouts.js";

export interface BuiltinFunctionEntryOperands {
  readonly typeIdx: number;
  readonly metadataId: number;
  readonly liftedTypeIdx: number;
  readonly singleton: number;
  readonly lifted: FuncHandle;
  readonly algorithm: FuncHandle;
  readonly initialName: readonly Instr[];
  readonly initialLength: number;
  readonly userFormalCount: number;
  readonly id: string;
  readonly behavior: "function-prototype" | "throw-type-error" | "unavailable";
  /** "object-prototype", "function-prototype", or the id of an earlier entry. */
  readonly prototype: string;
  readonly constructible: boolean;
  readonly prototypeObject?: { readonly id: string; readonly prototype: string | null };
}
/** (#7350 B2b) What the identity entries' `prototype` objects are built with; present only with such entries. */
export interface BuiltinFunctionIdentityOperands {
  readonly createWithPrototype: FuncHandle;
  readonly prototypeKey: readonly Instr[];
  readonly constructorKey: readonly Instr[];
}
export interface BuiltinFunctionBodyOperands {
  readonly rootTypeIdx: number;
  readonly realmTypeIdx: number;
  readonly objectTypeIdx: number;
  readonly vectorTypeIdx: number;
  readonly vectorArrayTypeIdx: number;
  readonly realm: number;
  readonly objectPrototype: number;
  readonly state: number;
  readonly undefinedGlobal: number;
  readonly initializer: FuncHandle;
  readonly match: FuncHandle;
  readonly callVector: FuncHandle;
  readonly bag: FuncHandle;
  readonly newVector: FuncHandle;
  readonly push: FuncHandle;
  readonly createNull: FuncHandle;
  readonly boxNumber: FuncHandle;
  readonly defineDataBody: FuncHandle;
  readonly defineAttributes: FuncHandle;
  readonly typeError: FuncHandle;
  readonly exceptionTag: number;
  readonly lengthKey: readonly Instr[];
  readonly nameKey: readonly Instr[];
  readonly errors: readonly (readonly Instr[])[];
  readonly entries: readonly BuiltinFunctionEntryOperands[];
  readonly identity?: BuiltinFunctionIdentityOperands;
}
export type BuiltinFunctionDefinition = { locals: LocalDef[]; body: Instr[] };
const get = (index: number): Instr => ({ op: "local.get", index });
const global = (index: number): Instr => ({ op: "global.get", index });
const call = (funcIdx: FuncHandle): Instr => ({ op: "call", funcIdx });
export function builtinUndefined(d: BuiltinFunctionBodyOperands): Instr[] {
  return [global(d.undefinedGlobal), { op: "extern.convert_any" }];
}
export function builtinFailure(d: BuiltinFunctionBodyOperands, ordinal = 0): Instr[] {
  return [...structuredClone(d.errors[ordinal]!), call(d.typeError), { op: "throw", tagIdx: d.exceptionTag }];
}
export function builtinRoot(d: BuiltinFunctionBodyOperands, local = 0): Instr[] {
  return [get(local), { op: "any.convert_extern" }, { op: "ref.cast", typeIdx: d.rootTypeIdx }];
}
export function buildBuiltinFunctionMatchDefinition(d: BuiltinFunctionBodyOperands): BuiltinFunctionDefinition {
  return {
    locals: [{ name: "candidate", type: { kind: "anyref" } }],
    body: [
      call(d.initializer),
      get(0),
      { op: "any.convert_extern" },
      { op: "local.set", index: 1 },
      ...d.entries.flatMap((entry, index): Instr[] => [
        get(1),
        { op: "ref.test", typeIdx: entry.typeIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            get(1),
            { op: "ref.cast", typeIdx: entry.typeIdx },
            { op: "struct.get", typeIdx: entry.typeIdx, fieldIdx: BFN_ID_FIELD_IDX },
            { op: "i32.const", value: entry.metadataId },
            { op: "i32.eq" },
            get(1),
            { op: "ref.cast", typeIdx: entry.typeIdx },
            { op: "struct.get", typeIdx: entry.typeIdx, fieldIdx: BUILTIN_FUNCTION_REALM_FIELD },
            global(d.realm),
            { op: "ref.eq" },
            { op: "i32.and" },
            get(1),
            { op: "ref.cast", typeIdx: entry.typeIdx },
            global(entry.singleton),
            { op: "ref.eq" },
            { op: "i32.and" },
            get(1),
            { op: "ref.cast", typeIdx: entry.typeIdx },
            { op: "struct.get", typeIdx: entry.typeIdx, fieldIdx: CLOSURE_FUNC_FIELD_IDX },
            { op: "ref.test", typeIdx: entry.liftedTypeIdx },
            { op: "i32.and" },
            { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: index + 1 }, { op: "return" }] },
          ],
        },
      ]),
      { op: "i32.const", value: 0 },
    ],
  };
}
/** The externref of `entry`'s singleton. */
const singleton = (entry: BuiltinFunctionEntryOperands): Instr[] => [
  global(entry.singleton),
  { op: "extern.convert_any" },
];
/** The `$Object` the externref `object` produces, cast from its carrier. */
function openObject(objectTypeIdx: number, object: () => Instr[]): Instr[] {
  return [...object(), { op: "any.convert_extern" }, { op: "ref.cast", typeIdx: objectTypeIdx }];
}
/** (#7350 B2b) Whether `object` carries the identity-only mark (`BUILTIN_IDENTITY_ONLY_FLAG`): a non-zero i32. */
export function isIdentityOnly(objectTypeIdx: number, object: () => Instr[]): Instr[] {
  return [
    ...openObject(objectTypeIdx, object),
    { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: OPEN_OBJECT_FLAGS_FIELD },
    { op: "i32.const", value: BUILTIN_IDENTITY_ONLY_FLAG },
    { op: "i32.and" },
  ];
}
/** (#7350 B2b) Set the identity-only mark on `object`. */
export function markIdentityOnly(objectTypeIdx: number, object: () => Instr[]): Instr[] {
  return [
    ...openObject(objectTypeIdx, object),
    ...openObject(objectTypeIdx, object),
    { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: OPEN_OBJECT_FLAGS_FIELD },
    { op: "i32.const", value: BUILTIN_IDENTITY_ONLY_FLAG },
    { op: "i32.or" },
    { op: "struct.set", typeIdx: objectTypeIdx, fieldIdx: OPEN_OBJECT_FLAGS_FIELD },
  ];
}
/** DefinePropertyOrThrow of a data property with the descriptor word `flags`; the answer is dropped. */
function defineData(
  d: BuiltinFunctionBodyOperands,
  object: Instr[],
  key: readonly Instr[],
  value: Instr[],
  flags: number,
) {
  return [
    ...object,
    ...structuredClone(key),
    ...value,
    { op: "f64.const", value: flags },
    call(d.defineDataBody),
    { op: "drop" },
  ] as Instr[];
}
/**
 * A data property's whole descriptor word (`ORDINARY_OBJECT_DESCRIPTOR_ENCODING`): every attribute and the value
 * present, the attributes `attributes` names true, the others false.
 */
export function dataPropertyDescriptor(...attributes: readonly ("writable" | "enumerable" | "configurable")[]): number {
  const encoding = ORDINARY_OBJECT_DESCRIPTOR_ENCODING;
  return attributes.reduce(
    (word, attribute) => word | encoding[attribute],
    encoding.writableSpecified | encoding.enumerableSpecified | encoding.configurableSpecified | encoding.hasValue,
  );
}
/** A built-in function's `length` and `name`, a constructor's `prototype`, and that object's `constructor`. */
const FUNCTION_METADATA = dataPropertyDescriptor("configurable"),
  CONSTRUCTOR_PROTOTYPE = dataPropertyDescriptor(),
  PROTOTYPE_CONSTRUCTOR = dataPropertyDescriptor("writable", "configurable");
/**
 * (#7350 B2b) An identity entry's seed after its `length` and `name`: the identity mark on its own properties, and its
 * own `prototype` object — a realm anchor, or a fresh object (kept in `locals`) whose `constructor` links back.
 */
function identitySeed(
  d: BuiltinFunctionBodyOperands,
  entry: BuiltinFunctionEntryOperands,
  bag: () => Instr[],
  locals: Map<string, number>,
): Instr[] {
  const body = markIdentityOnly(d.objectTypeIdx, bag);
  const object = entry.prototypeObject;
  if (object === undefined) return body;
  const identity = d.identity!;
  const anchor = (id: string | null): Instr[] =>
    id === "%Object.prototype%"
      ? [global(d.objectPrototype)]
      : id === "%Function.prototype%"
        ? singleton(d.entries[0]!)
        : [{ op: "local.get", index: locals.get(id!)! }];
  if (object.id === "%Function.prototype%")
    body.push(...markIdentityOnly(d.objectTypeIdx, () => functionPrototypeBag(d)));
  else if (object.id !== "%Object.prototype%") {
    const local = locals.size;
    body.push(
      ...anchor(object.prototype),
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: d.objectTypeIdx },
      call(identity.createWithPrototype),
      { op: "local.set", index: local },
    );
    locals.set(object.id, local);
    body.push(
      ...markIdentityOnly(d.objectTypeIdx, () => anchor(object.id)),
      ...defineData(d, anchor(object.id), identity.constructorKey, singleton(entry), PROTOTYPE_CONSTRUCTOR),
    );
  }
  body.push(...defineData(d, bag(), identity.prototypeKey, anchor(object.id), CONSTRUCTOR_PROTOTYPE));
  return body;
}
const functionPrototypeBag = (d: BuiltinFunctionBodyOperands): Instr[] => [
  global(d.entries[0]!.singleton),
  { op: "ref.as_non_null" },
  { op: "struct.get", typeIdx: d.entries[0]!.typeIdx, fieldIdx: CLOSURE_BAG_FIELD_IDX },
];
export function buildBuiltinFunctionInitializer(d: BuiltinFunctionBodyOperands): BuiltinFunctionDefinition {
  const byId = new Map(d.entries.map((entry) => [entry.id, entry]));
  const allocate: Instr[] = [
    { op: "struct.new", typeIdx: d.realmTypeIdx },
    { op: "global.set", index: d.realm },
    call(d.createNull),
    { op: "global.set", index: d.objectPrototype },
    ...d.entries.flatMap((entry): Instr[] => [
      { op: "ref.func", funcIdx: entry.lifted },
      { op: "i32.const", value: entry.userFormalCount },
      call(d.createNull),
      { op: "i32.const", value: 0 },
      { op: "i32.const", value: entry.metadataId },
      ...(entry.prototype === "object-prototype"
        ? [global(d.objectPrototype)]
        : singleton(entry.prototype === "function-prototype" ? d.entries[0]! : byId.get(entry.prototype)!)),
      global(d.realm),
      { op: "ref.as_non_null" },
      ...structuredClone(entry.initialName),
      { op: "struct.new", typeIdx: entry.typeIdx },
      { op: "global.set", index: entry.singleton },
    ]),
  ];
  const prototypeObjects = new Map<string, number>();
  const seed: Instr[] = d.entries.flatMap((entry) => {
    const bag = (): Instr[] => [
      global(entry.singleton),
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: entry.typeIdx, fieldIdx: CLOSURE_BAG_FIELD_IDX },
    ];
    const body: Instr[] = [
      ...defineData(
        d,
        bag(),
        d.lengthKey,
        [{ op: "f64.const", value: entry.initialLength }, call(d.boxNumber)],
        FUNCTION_METADATA,
      ),
      ...defineData(
        d,
        bag(),
        d.nameKey,
        [...structuredClone(entry.initialName), { op: "extern.convert_any" }],
        FUNCTION_METADATA,
      ),
    ];
    if (entry.behavior === "unavailable") body.push(...identitySeed(d, entry, bag, prototypeObjects));
    if (entry.behavior === "throw-type-error")
      body.push(
        ...bag(),
        ...structuredClone(d.lengthKey),
        { op: "f64.const", value: 32 },
        call(d.defineAttributes),
        ...bag(),
        ...structuredClone(d.nameKey),
        { op: "f64.const", value: 32 },
        call(d.defineAttributes),
        ...bag(),
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: d.objectTypeIdx },
        { op: "i32.const", value: 0x81 },
        { op: "struct.set", typeIdx: d.objectTypeIdx, fieldIdx: 4 },
      );
    return body;
  });
  return {
    locals: [...prototypeObjects.keys()].map((id) => ({ name: id, type: { kind: "externref" } })),
    body: [
      global(d.state),
      { op: "i32.const", value: -1 },
      { op: "i32.eq" },
      { op: "if", blockType: { kind: "empty" }, then: builtinFailure(d, 3) },
      global(d.state),
      { op: "if", blockType: { kind: "empty" }, then: [{ op: "return" }] },
      { op: "i32.const", value: 1 },
      { op: "global.set", index: d.state },
      {
        op: "try",
        blockType: { kind: "empty" },
        body: [...allocate, ...seed, { op: "i32.const", value: 2 }, { op: "global.set", index: d.state }],
        catches: [],
        catchAll: [
          { op: "i32.const", value: -1 },
          { op: "global.set", index: d.state },
          { op: "rethrow", depth: 0 },
        ],
      },
    ],
  };
}
export function buildBuiltinFunctionSingletonDefinition(
  d: BuiltinFunctionBodyOperands,
  entry: BuiltinFunctionEntryOperands,
): BuiltinFunctionDefinition {
  return {
    locals: [],
    body: [call(d.initializer), global(entry.singleton), { op: "ref.as_non_null" }, { op: "extern.convert_any" }],
  };
}
/**
 * [[Construct]] of a kernel function: (#7350 B2b) an identity constructor's algorithm is not implemented, so it aborts;
 * every other function is not a constructor (a TypeError).
 */
export function buildBuiltinFunctionConstructDefinition(d: BuiltinFunctionBodyOperands): BuiltinFunctionDefinition {
  const constructible = d.entries.flatMap((entry, ordinal) => (entry.constructible ? [ordinal + 1] : []));
  return {
    locals: [],
    body: [
      ...constructible.flatMap((ordinal): Instr[] => [
        get(0),
        call(d.match),
        { op: "i32.const", value: ordinal },
        { op: "i32.eq" },
        { op: "if", blockType: { kind: "empty" }, then: [{ op: "unreachable" }] },
      ]),
      ...builtinFailure(d, 1),
    ],
  };
}
/** No source argc/this/extras or active-realm global is touched by this transport. */
export function buildBuiltinFunctionLiftedDefinition(
  d: BuiltinFunctionBodyOperands,
  entry: BuiltinFunctionEntryOperands,
  ordinal: number,
): BuiltinFunctionDefinition {
  return {
    locals: [],
    body: [
      get(0),
      { op: "extern.convert_any" },
      call(d.match),
      { op: "i32.const", value: ordinal + 1 },
      { op: "i32.ne" },
      { op: "if", blockType: { kind: "empty" }, then: builtinFailure(d) },
      get(1),
      get(2),
      call(entry.algorithm),
    ],
  };
}
export function buildBuiltinFunctionAlgorithmDefinition(
  d: BuiltinFunctionBodyOperands,
  behavior: BuiltinFunctionEntryOperands["behavior"],
): BuiltinFunctionDefinition {
  // (#7350 B2b) An identity entry's algorithm is not implemented: calling it aborts, never a catchable error.
  if (behavior === "unavailable") return { locals: [], body: [{ op: "unreachable" }] };
  return { locals: [], body: behavior === "function-prototype" ? builtinUndefined(d) : builtinFailure(d, 2) };
}
export function buildBuiltinFunctionCallDefinition(d: BuiltinFunctionBodyOperands): BuiltinFunctionDefinition {
  return {
    locals: [{ name: "ordinal", type: { kind: "i32" } }],
    body: [
      get(0),
      call(d.match),
      { op: "local.set", index: 3 },
      ...d.entries.flatMap((entry, ordinal): Instr[] => [
        get(3),
        { op: "i32.const", value: ordinal + 1 },
        { op: "i32.eq" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            ...builtinRoot(d),
            get(1),
            get(2),
            ...builtinRoot(d),
            { op: "struct.get", typeIdx: d.rootTypeIdx, fieldIdx: CLOSURE_FUNC_FIELD_IDX },
            { op: "ref.cast", typeIdx: entry.liftedTypeIdx },
            { op: "call_ref", typeIdx: entry.liftedTypeIdx },
            { op: "return" },
          ],
        },
      ]),
      ...builtinFailure(d),
    ],
  };
}
/** Checked named-argument load preserves omission separately in the vector's actual length. */
export function buildBuiltinFunctionArgument(
  d: Pick<BuiltinFunctionBodyOperands, "vectorTypeIdx" | "vectorArrayTypeIdx" | "undefinedGlobal">,
  vectorLocal: number,
  argument: number,
): Instr[] {
  if (!Number.isSafeInteger(argument) || argument < 0) throw new Error("builtin argument: invalid index");
  return [
    get(vectorLocal),
    { op: "struct.get", typeIdx: d.vectorTypeIdx, fieldIdx: 0 },
    { op: "i32.const", value: argument },
    { op: "i32.gt_u" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "externref" } },
      then: [
        get(vectorLocal),
        { op: "struct.get", typeIdx: d.vectorTypeIdx, fieldIdx: 1 },
        { op: "i32.const", value: argument },
        { op: "array.get", typeIdx: d.vectorArrayTypeIdx },
      ],
      else: [global(d.undefinedGlobal), { op: "extern.convert_any" }],
    },
  ];
}
export function buildBuiltinFunctionMethodDefinition(
  d: BuiltinFunctionBodyOperands,
  arity: number,
): BuiltinFunctionDefinition {
  const vector = arity + 2;
  return {
    locals: [{ name: "arguments", type: { kind: "externref" } }],
    body: [
      call(d.newVector),
      { op: "local.set", index: vector },
      ...Array.from({ length: arity }, (_, index): Instr[] => [get(vector), get(index + 2), call(d.push)]).flat(),
      get(0),
      get(1),
      get(vector),
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: d.vectorTypeIdx },
      call(d.callVector),
    ],
  };
}
export function buildBuiltinFunctionSlotDefinition(
  d: BuiltinFunctionBodyOperands,
  slot: "bag" | "prototype" | "initialName" | "arity",
): BuiltinFunctionDefinition {
  const body: Instr[] = [
    get(0),
    call(d.match),
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: builtinFailure(d) },
  ];
  if (slot === "bag" || slot === "arity")
    body.push(...builtinRoot(d), {
      op: "struct.get",
      typeIdx: d.rootTypeIdx,
      fieldIdx: slot === "bag" ? CLOSURE_BAG_FIELD_IDX : CLOSURE_ARITY_FIELD_IDX,
    });
  else
    for (const entry of d.entries)
      body.push(
        ...builtinRoot(d),
        global(entry.singleton),
        { op: "ref.eq" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            get(0),
            { op: "any.convert_extern" },
            { op: "ref.cast", typeIdx: entry.typeIdx },
            {
              op: "struct.get",
              typeIdx: entry.typeIdx,
              fieldIdx: slot === "prototype" ? BUILTIN_FUNCTION_PROTOTYPE_FIELD : BUILTIN_FUNCTION_INITIAL_NAME_FIELD,
            },
            ...(slot === "initialName" ? [{ op: "extern.convert_any" } as Instr] : []),
            { op: "return" },
          ],
        },
      );
  if (slot === "prototype" || slot === "initialName") body.push({ op: "unreachable" });
  return { locals: [], body };
}
