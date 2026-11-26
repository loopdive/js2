// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 O1) Bodies of the public source-object functions: each puts one `js.object.*` contract's signature in front
 * of the realm kernel's own algorithm, so no object algorithm is written twice.
 */
import type { FuncHandle, Instr, LocalDef, TypeHandle } from "../../../wasm/model/instructions.js";
import { ORDINARY_OBJECT_DESCRIPTOR_ENCODING as flags } from "./ordinary-object-descriptor-common.js";
import { PROP_ENTRY_FIELD } from "./object-layouts.js";
import { buildAccessorCall, builtinAccessorCall } from "./builtin-function-property-bodies.js";
import { kernelGetInto } from "./kernel-get-body.js";
import type { BuiltinFunctionPrototypeOperands } from "./builtin-function-prototype-bodies.js";

export interface SourceObjectDefinition {
  readonly locals: LocalDef[];
  readonly body: Instr[];
}

/**
 * `js.object.create-default`: OrdinaryObjectCreate(%Object.prototype%) with an explicit link to the realm's
 * Object.prototype, so a lookup never meets the storage's implicit-prototype state.
 */
export function buildSourceObjectCreateDefinition(d: SourceObjectCreateOperands): SourceObjectDefinition {
  return { locals: [], body: sourceObjectCreate(d) };
}

export interface SourceObjectCreateOperands {
  readonly objectTypeIdx: TypeHandle;
  readonly objectPrototype: FuncHandle;
  readonly createWithPrototype: FuncHandle;
}

/** The `create-default` instructions, leaving the new object's externref; (#7354 F1b) also a function's prototype. */
export function sourceObjectCreate(d: SourceObjectCreateOperands): Instr[] {
  return [
    { op: "call", funcIdx: d.objectPrototype },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: d.objectTypeIdx },
    { op: "call", funcIdx: d.createWithPrototype },
  ];
}

/**
 * (#7354 C2) `js.object.create-with-prototype(prototype)`: OrdinaryObjectCreate(prototype) for an ordinary object of
 * this realm, [[Construct]]'s new object. Its caller passes only a value of the object kind; any other prototype is
 * the realm's Object.prototype (`create-default`) or the run-time abort there.
 */
export function buildSourceObjectCreateWithPrototypeDefinition(d: SourceObjectCreateOperands): SourceObjectDefinition {
  return {
    locals: [],
    body: [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: d.objectTypeIdx },
      { op: "call", funcIdx: d.createWithPrototype },
    ],
  };
}

/**
 * (#7354 C2) `js.object.inherits(object, prototype) -> i32`: OrdinaryHasInstance's walk (§7.3.21 step 6) over an
 * ordinary object's [[Prototype]] links. Every link of such an object is an explicit ordinary object
 * (`create-default`, `create-with-prototype`) ending at the realm's Object.prototype, whose link is null, so the walk
 * meets no other layout.
 */
export function buildSourceObjectInheritsDefinition(d: {
  readonly objectTypeIdx: TypeHandle;
  readonly sameValue: FuncHandle;
}): SourceObjectDefinition {
  const cursor = 2;
  return {
    locals: [{ name: "cursor", type: { kind: "externref" } }],
    body: [
      { op: "local.get", index: 0 },
      { op: "local.set", index: cursor },
      {
        op: "loop",
        blockType: { kind: "empty" },
        body: [
          { op: "local.get", index: cursor },
          { op: "any.convert_extern" },
          { op: "ref.cast", typeIdx: d.objectTypeIdx },
          { op: "struct.get", typeIdx: d.objectTypeIdx, fieldIdx: 0 },
          { op: "extern.convert_any" },
          { op: "local.tee", index: cursor },
          { op: "ref.is_null" },
          { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 0 }, { op: "return" }] },
          { op: "local.get", index: cursor },
          { op: "local.get", index: 1 },
          { op: "call", funcIdx: d.sameValue },
          { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 1 }, { op: "return" }] },
          { op: "br", depth: 0 },
        ],
      },
      { op: "unreachable" },
    ],
  };
}

/**
 * `js.object.get(object, key, receiver)`: the kernel's [[Get]], whose absent answer already is `undefined`. Its
 * "incomplete parent" state is a miss at the realm's Object.prototype, which does not hold the specification's
 * properties yet: (#7354 O4) every caller refuses the keys Object.prototype defines (`builtin-prototype-keys.ts`), so
 * a miss there is a true miss and answers `undefined` too. (#7354 O2) A getter has run inside the kernel (status 1).
 * Its "unknown carrier" state (3), and any status outside the kernel's four, traps: every caller passes an ordinary
 * or function object of this realm.
 */
export function buildSourceObjectGetDefinition(d: { readonly get: FuncHandle }): SourceObjectDefinition {
  const operands: Instr[] = [0, 1, 2].map((index) => ({ op: "local.get", index }));
  return {
    locals: [{ name: "value", type: { kind: "externref" } }],
    body: [...kernelGetInto(d.get, operands, 3), { op: "local.get", index: 3 }],
  };
}

/** A data property's whole descriptor, every attribute present and true, with its value: CreateDataProperty's. */
export const CREATE_DATA_PROPERTY =
  flags.writable |
  flags.enumerable |
  flags.configurable |
  flags.writableSpecified |
  flags.enumerableSpecified |
  flags.configurableSpecified |
  flags.hasValue;

/**
 * (#7354 O3) `js.object.set(object, key, value, receiver)`: OrdinarySet (§10.1.9.2) over the kernel's own-property find
 * and lookup, the walk `get` takes. (#7354 F1b) An own writable data property of the receiver is updated with
 * `{ [[Value]] }` alone, so its attributes stay (a function's non-enumerable `prototype`, a prototype's
 * `constructor`); an inherited writable data property, or none (absent, or a miss at the realm's Object.prototype,
 * which every caller's key refusal makes a true miss), is CreateDataProperty on the receiver. A function's own
 * properties live in its bag, the storage both finds and defines use; (#7354 O1) an ordinary object's is itself. A
 * read-only data property (a function's own `length` or `name`, a property `Object.defineProperty` made read only)
 * or a setter-less accessor answers `false`; (#7354 O2) an accessor's setter is called with the receiver and the
 * value (`buildAccessorCall`), answering `true`. Without `accessorCalls` no source closure can be a setter: (#7489) a
 * built-in setter (%ThrowTypeError%) is the kernel's own call, anything else traps. A non-extensible receiver is unreachable: no Prepared program can make one yet
 * (`Object.preventExtensions`, slice O3).
 */
/** The kernel operands OrdinarySet reads: its walk, its define, and (#7354 O2) the accessor call's dispatch. */
type SourceObjectSetOperands = Pick<
  BuiltinFunctionPrototypeOperands,
  | "lookup"
  | "findOrdinary"
  | "defineData"
  | "bag"
  | "entryTypeIdx"
  | "objectTypeIdx"
  | "accessorCalls"
  | "match"
  | "entries"
  | "newVector"
  | "push"
  | "vectorTypeIdx"
  | "callVector"
>;
export function buildSourceObjectSetDefinition(d: SourceObjectSetOperands): SourceObjectDefinition {
  const [status, entry, storage, setter, vector] = [4, 5, 6, 7, 8];
  const calls = d.accessorCalls;
  const entryFlag = (flag: number): Instr[] => [
    { op: "local.get", index: entry },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: d.entryTypeIdx, fieldIdx: PROP_ENTRY_FIELD.flags },
    { op: "i32.const", value: flag },
    { op: "i32.and" },
  ];
  // A found property: (#7354 O1) an accessor without a setter answers false, (#7354 O2) one with a setter calls it
  // and answers true; a read-only data property answers false.
  const setterField: Instr[] = [
    { op: "local.get", index: entry },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: d.entryTypeIdx, fieldIdx: PROP_ENTRY_FIELD.set },
  ];
  const answered = (call: Instr[]): Instr[] => [
    ...call,
    { op: "drop" },
    { op: "i32.const", value: 1 },
    { op: "return" },
  ];
  // (#7489) Without `accessorCalls` a setter is a built-in (%ThrowTypeError%, %Function.prototype%'s `caller`).
  const callSetter: Instr[] = calls
    ? answered(buildAccessorCall(d, calls, setter, 3, [2]))
    : builtinAccessorCall(d, setter, 3, { local: 2, vector }, [{ op: "unreachable" }], answered);
  const requireWritable: Instr[] = [
    ...entryFlag(flags.accessor),
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...setterField,
        { op: "extern.convert_any" },
        { op: "local.tee", index: setter },
        { op: "ref.is_null" },
        { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 0 }, { op: "return" }] },
        ...callSetter,
      ],
    },
    ...entryFlag(flags.writable),
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 0 }, { op: "return" }] },
  ];
  // The define on the receiver's storage with descriptor word `word`, answering true.
  const define = (word: number): Instr[] => [
    { op: "local.get", index: storage },
    { op: "local.get", index: 1 },
    { op: "local.get", index: 2 },
    { op: "f64.const", value: word },
    { op: "call", funcIdx: d.defineData },
    { op: "i32.const", value: 1 },
  ];
  return {
    locals: [
      { name: "status", type: { kind: "i32" } },
      { name: "entry", type: { kind: "ref_null", typeIdx: d.entryTypeIdx } },
      { name: "storage", type: { kind: "externref" } },
      { name: "setter", type: { kind: "externref" } },
      ...(calls ? [] : [{ name: "arguments", type: { kind: "externref" } } satisfies LocalDef]),
    ],
    body: [
      // A function's own properties live in its bag; (#7354 O1) an ordinary object is its own.
      { op: "local.get", index: 3 },
      { op: "call", funcIdx: d.bag },
      { op: "local.tee", index: storage },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: d.objectTypeIdx },
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: d.findOrdinary },
      { op: "local.tee", index: entry },
      { op: "ref.is_null" },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [...requireWritable, ...define(flags.hasValue), { op: "return" }],
      },
      { op: "local.get", index: 0 },
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: d.lookup },
      { op: "local.set", index: entry },
      { op: "local.tee", index: status },
      { op: "i32.const", value: 1 },
      { op: "i32.eq" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: requireWritable,
        else: [
          { op: "local.get", index: status },
          { op: "i32.const", value: 2 },
          { op: "i32.gt_u" },
          { op: "if", blockType: { kind: "empty" }, then: [{ op: "unreachable" }] },
        ],
      },
      ...define(CREATE_DATA_PROPERTY),
    ],
  };
}
/**
 * (#7354 O2b) `js.object.has(object, key)`: the kernel's HasProperty, read as found (status 1). A miss at the realm's
 * Object.prototype (2) is absent, as in the get adapter: its one caller, OrdinaryToPrimitive, takes an absent
 * conversion method for the realm Object.prototype's own. Status 3 traps, as in the get adapter.
 */
export function buildSourceObjectHasDefinition(d: { readonly has: FuncHandle }): SourceObjectDefinition {
  return {
    locals: [{ name: "status", type: { kind: "i32" } }],
    body: [
      { op: "local.get", index: 0 },
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: d.has },
      { op: "local.tee", index: 2 },
      { op: "i32.const", value: 2 },
      { op: "i32.gt_u" },
      { op: "if", blockType: { kind: "empty" }, then: [{ op: "unreachable" }] },
      { op: "local.get", index: 2 },
      { op: "i32.const", value: 1 },
      { op: "i32.eq" },
    ],
  };
}

/**
 * (#7354 P1, G1) `js.object.intrinsic(selector) -> externref`: the built-in function object `selector` names
 * (`NATIVE_VALUE_INTRINSICS`), through its entry's getter (which initializes the realm first). `getters` holds the
 * entries the realm has; the caller passes only selectors whose entry the realm holds (it holds what is named).
 */
export function buildSourceObjectIntrinsicDefinition(d: {
  readonly getters: readonly { readonly selector: number; readonly getter: FuncHandle }[];
}): SourceObjectDefinition {
  return {
    locals: [],
    body: [
      ...d.getters.flatMap(({ getter, selector }): Instr[] => [
        { op: "local.get", index: 0 },
        { op: "i32.const", value: selector },
        { op: "i32.eq" },
        { op: "if", blockType: { kind: "empty" }, then: [{ op: "call", funcIdx: getter }, { op: "return" }] },
      ]),
      { op: "unreachable" },
    ],
  };
}

/**
 * (#7354 P1) `js.object.has-own(object, key, selector) -> i32`: HasOwnProperty (§7.3.12) of a canonical key on an
 * ordinary or function object, through the kernel's own-property find (a function's own properties are in its bag);
 * selector 1 also requires the property to be enumerable (`propertyIsEnumerable`, §20.1.3.4).
 */
export function buildSourceObjectHasOwnDefinition(d: {
  readonly entryTypeIdx: TypeHandle;
  readonly findOwn: FuncHandle;
}): SourceObjectDefinition {
  const entry = 3;
  return {
    locals: [{ name: "entry", type: { kind: "ref_null", typeIdx: d.entryTypeIdx } }],
    body: [
      { op: "local.get", index: 0 },
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: d.findOwn },
      { op: "local.tee", index: entry },
      { op: "ref.is_null" },
      { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 0 }, { op: "return" }] },
      { op: "local.get", index: 2 },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [
          { op: "local.get", index: entry },
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: d.entryTypeIdx, fieldIdx: PROP_ENTRY_FIELD.flags },
          { op: "i32.const", value: flags.enumerable },
          { op: "i32.and" },
          { op: "i32.const", value: 0 },
          { op: "i32.ne" },
        ],
        else: [{ op: "i32.const", value: 1 }],
      },
    ],
  };
}
