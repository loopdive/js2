// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 O1) Bodies of the public source-object functions: each puts one `js.object.*` contract's signature in front
 * of the realm kernel's own algorithm, so no object algorithm is written twice.
 */
import type { FuncHandle, Instr, LocalDef, TypeHandle } from "../../../wasm/model/instructions.js";
import { ORDINARY_OBJECT_DESCRIPTOR_ENCODING as flags } from "./ordinary-object-descriptor-common.js";
import { PROP_ENTRY_FIELD } from "./object-layouts.js";

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
 * a miss there is a true miss and answers `undefined` too. Its "not an object" state (3), and any status outside the
 * kernel's four, traps: every object a source program reaches was built by `create-default` on this realm's
 * Object.prototype.
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
      { op: "i32.gt_u" },
      { op: "if", blockType: { kind: "empty" }, then: [{ op: "unreachable" }] },
      { op: "local.get", index: 3 },
    ],
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
 * or a setter-less accessor answers `false`; a setter call traps, as an unknown carrier (status 3) does. A
 * non-extensible receiver is unreachable: no Prepared program can make one yet (`Object.preventExtensions`, slice O3).
 */
export function buildSourceObjectSetDefinition(d: {
  readonly entryTypeIdx: TypeHandle;
  readonly objectTypeIdx: TypeHandle;
  readonly findOwn: FuncHandle;
  readonly lookup: FuncHandle;
  readonly defineData: FuncHandle;
  readonly bag: FuncHandle;
}): SourceObjectDefinition {
  const [status, entry, storage] = [4, 5, 6];
  const entryFlag = (flag: number): Instr[] => [
    { op: "local.get", index: entry },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: d.entryTypeIdx, fieldIdx: PROP_ENTRY_FIELD.flags },
    { op: "i32.const", value: flag },
    { op: "i32.and" },
  ];
  // A found property: (#7354 O1) an accessor without a setter answers false, one with a setter is the run-time abort
  // until the realm calls a source setter (slice O2); a read-only data property answers false.
  const requireWritable: Instr[] = [
    ...entryFlag(flags.accessor),
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: entry },
        { op: "ref.as_non_null" },
        { op: "struct.get", typeIdx: d.entryTypeIdx, fieldIdx: PROP_ENTRY_FIELD.set },
        { op: "ref.is_null" },
        { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 0 }, { op: "return" }] },
        { op: "unreachable" },
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
    ],
    body: [
      // A function's own properties live in its bag; (#7354 O1) an ordinary object is its own.
      { op: "local.get", index: 3 },
      { op: "call", funcIdx: d.bag },
      { op: "local.tee", index: storage },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: d.objectTypeIdx },
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: d.findOwn },
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

/** (#7354 M2) `js.object.is-error(value) -> i32`: whether `value` is the realm's error layout (`$Error_struct`). */
export function buildSourceObjectIsErrorDefinition(d: { readonly errorTypeIdx: number }): SourceObjectDefinition {
  return {
    locals: [],
    body: [{ op: "local.get", index: 0 }, { op: "any.convert_extern" }, { op: "ref.test", typeIdx: d.errorTypeIdx }],
  };
}

/**
 * (#7354 M2) `js.object.error-field(error, selector) -> externref`: the error's `name` (selector 1) or `message`
 * (selector 0) field. The caller has tested the error kind, so the cast cannot fail.
 */
export function buildSourceObjectErrorFieldDefinition(d: { readonly errorTypeIdx: number }): SourceObjectDefinition {
  const field = (fieldIdx: number): Instr[] => [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: d.errorTypeIdx },
    { op: "struct.get", typeIdx: d.errorTypeIdx, fieldIdx },
  ];
  return {
    locals: [],
    body: [
      { op: "local.get", index: 1 },
      { op: "if", blockType: { kind: "val", type: { kind: "externref" } }, then: field(2), else: field(1) },
    ],
  };
}
