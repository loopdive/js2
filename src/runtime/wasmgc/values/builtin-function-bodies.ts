// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr, LocalDef, FuncHandle } from "../../../wasm/model/instructions.js";
import { buildStandardTryTable } from "../../../wasm/physical/exception-control.js";
import {
  BFN_ID_FIELD_IDX,
  CLOSURE_ARITY_FIELD_IDX,
  CLOSURE_BAG_FIELD_IDX,
  CLOSURE_FUNC_FIELD_IDX,
} from "./closure-layouts.js";
import {
  BUILTIN_FUNCTION_REALM_FIELD,
  BUILTIN_FUNCTION_PROTOTYPE_FIELD,
  BUILTIN_FUNCTION_INITIAL_NAME_FIELD,
} from "./builtin-function-layouts.js";
import { ORDINARY_OBJECT_DESCRIPTOR_ENCODING as flags } from "./ordinary-object-descriptor-common.js";
import { realmFamilyAllocation, realmFamilySeed, type RealmFamilyOperands } from "./realm-family-bodies.js";

export interface BuiltinFunctionEntryOperands {
  readonly id: string;
  readonly typeIdx: number;
  /** The closure metadata type this carrier extends; `match` excludes its subtypes from the source arm. */
  readonly metadataTypeIdx: number;
  readonly metadataId: number;
  readonly liftedTypeIdx: number;
  readonly singleton: number;
  readonly lifted: FuncHandle;
  readonly algorithm: FuncHandle;
  readonly initialName: readonly Instr[];
  readonly initialLength: number;
  readonly userFormalCount: number;
  /**
   * (#7354 P1) An `object-prototype-method` is a data property of the realm's Object.prototype; (#7354 G1) a `native`
   * family member's holder is in its family's property lists.
   */
  readonly behavior: "function-prototype" | "throw-type-error" | "object-prototype-method" | "native";
  /** `object-prototype`, `function-prototype`, or (#7354 G1) an earlier entry's id. */
  readonly prototype: string;
  readonly properties: RealmFamilyOperands["entries"][number]["properties"];
}
export interface BuiltinFunctionBodyOperands extends Pick<
  RealmFamilyOperands,
  "createWithPrototype" | "text" | "objects"
> {
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
  /**
   * (#7354 O2) Where a source closure can be an accessor half: per arity (0 a getter, 1 a setter) the program's
   * dispatcher `(receiver, callee, …args)` and the kernel's own call of a built-in `(callee, receiver, …args)`.
   */
  readonly accessorCalls?: {
    readonly source: readonly [FuncHandle, FuncHandle];
    readonly builtin: readonly [FuncHandle, FuncHandle];
  };
}
export type BuiltinFunctionDefinition = { locals: LocalDef[]; body: Instr[] };
/** (#7354 P1) A writable, non-enumerable, configurable data property's descriptor word, every field present. */
const OBJECT_PROTOTYPE_METHOD_WORD =
  flags.writable |
  flags.configurable |
  flags.writableSpecified |
  flags.enumerableSpecified |
  flags.configurableSpecified |
  flags.hasValue;
const get = (index: number): Instr => ({ op: "local.get", index });
const global = (index: number): Instr => ({ op: "global.get", index });
const call = (funcIdx: FuncHandle): Instr => ({ op: "call", funcIdx });
export function builtinUndefined(d: BuiltinFunctionBodyOperands): Instr[] {
  return [global(d.undefinedGlobal), { op: "extern.convert_any" }];
}
/** Throw a TypeError carrying `message` (an externref string) on the kernel's exception tag. */
export function builtinTypeError(
  d: Pick<BuiltinFunctionBodyOperands, "typeError" | "exceptionTag">,
  message: readonly Instr[],
): Instr[] {
  return [...structuredClone(message), call(d.typeError), { op: "throw", tagIdx: d.exceptionTag }];
}
export function builtinFailure(d: BuiltinFunctionBodyOperands, ordinal = 0): Instr[] {
  return builtinTypeError(d, d.errors[ordinal]!);
}
export function builtinRoot(d: BuiltinFunctionBodyOperands, local = 0): Instr[] {
  return [get(local), { op: "any.convert_extern" }, { op: "ref.cast", typeIdx: d.rootTypeIdx }];
}
/** (#7354 C) `match`'s answer for a source closure: one ordinal after the builtin entries. */
export function sourceClosureOrdinal(d: Pick<BuiltinFunctionBodyOperands, "entries">): number {
  return d.entries.length + 1;
}
/**
 * The function-object ordinal of a value: a builtin entry's (1..n) when it is that entry's own singleton of this
 * realm, {@link sourceClosureOrdinal} for a source closure, 0 otherwise. A source closure is the closure root without
 * builtin metadata: every builtin carrier, a clone or forgery included, is a metadata subtype, and no source capture
 * layout can coincide with it (`requireSourceMetadataSeparation`), so the exclusion keeps forgeries out of both arms.
 */
export function buildBuiltinFunctionMatchDefinition(d: BuiltinFunctionBodyOperands): BuiltinFunctionDefinition {
  const metadataTypes = [...new Set(d.entries.map((entry) => entry.metadataTypeIdx))];
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
      get(1),
      { op: "ref.test", typeIdx: d.rootTypeIdx },
      ...metadataTypes.flatMap((typeIdx): Instr[] => [
        get(1),
        { op: "ref.test", typeIdx },
        { op: "i32.eqz" },
        { op: "i32.and" },
      ]),
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [{ op: "i32.const", value: sourceClosureOrdinal(d) }],
        else: [{ op: "i32.const", value: 0 }],
      },
    ],
  };
}
/**
 * OrdinaryFunctionCreate's `length`, then SetFunctionName's `name`: non-writable, non-enumerable, configurable data
 * properties (descriptor word 0xbc). Builtin and (#7354 C) source functions share it; each supplies the object it
 * defines on, the define function (both answer an externref, dropped) and the f64 length and externref name.
 */
export function buildFunctionLengthNameSeed(
  d: Pick<BuiltinFunctionBodyOperands, "lengthKey" | "nameKey" | "boxNumber">,
  target: () => Instr[],
  define: FuncHandle,
  length: readonly Instr[],
  name: readonly Instr[],
): Instr[] {
  return [
    ...target(),
    ...structuredClone(d.lengthKey),
    ...structuredClone(length),
    call(d.boxNumber),
    { op: "f64.const", value: 0xbc },
    call(define),
    { op: "drop" },
    ...target(),
    ...structuredClone(d.nameKey),
    ...structuredClone(name),
    { op: "f64.const", value: 0xbc },
    call(define),
    { op: "drop" },
  ];
}
/**
 * An entry's [[Prototype]]: Object.prototype for %Function.prototype%, %Function.prototype% for every other one but
 * (#7354 G1) a family member linked to an earlier entry (a NativeError constructor to %Error%).
 */
function entryPrototype(d: BuiltinFunctionBodyOperands, entry: BuiltinFunctionEntryOperands): Instr[] {
  if (entry.behavior === "function-prototype") return [global(d.objectPrototype)];
  const linked =
    entry.prototype === "function-prototype" ? d.entries[0] : d.entries.find(({ id }) => id === entry.prototype);
  return [global(linked!.singleton), { op: "extern.convert_any" }];
}
export function buildBuiltinFunctionInitializer(d: BuiltinFunctionBodyOperands): BuiltinFunctionDefinition {
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
      ...entryPrototype(d, entry),
      global(d.realm),
      { op: "ref.as_non_null" },
      ...structuredClone(entry.initialName),
      { op: "struct.new", typeIdx: entry.typeIdx },
      { op: "global.set", index: entry.singleton },
    ]),
    // (#7354 G1) The held families' prototype objects, once every entry they hold exists.
    ...realmFamilyAllocation(d),
  ];
  const seed: Instr[] = d.entries.flatMap((entry) => {
    const bag = (): Instr[] => [
      global(entry.singleton),
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: entry.typeIdx, fieldIdx: CLOSURE_BAG_FIELD_IDX },
    ];
    const body = buildFunctionLengthNameSeed(
      d,
      bag,
      d.defineDataBody,
      [{ op: "f64.const", value: entry.initialLength }],
      [...entry.initialName, { op: "extern.convert_any" }],
    );
    // (#7354 P1) A method is Object.prototype's writable, non-enumerable, configurable data property, keyed by its name.
    if (entry.behavior === "object-prototype-method")
      body.push(
        global(d.objectPrototype),
        ...structuredClone(entry.initialName),
        { op: "extern.convert_any" },
        global(entry.singleton),
        { op: "extern.convert_any" },
        { op: "f64.const", value: OBJECT_PROTOTYPE_METHOD_WORD },
        call(d.defineDataBody),
        { op: "drop" },
      );
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
    locals: [],
    body: [
      global(d.state),
      { op: "i32.const", value: -1 },
      { op: "i32.eq" },
      { op: "if", blockType: { kind: "empty" }, then: builtinFailure(d, 3) },
      global(d.state),
      { op: "if", blockType: { kind: "empty" }, then: [{ op: "return" }] },
      { op: "i32.const", value: 1 },
      { op: "global.set", index: d.state },
      // A standard try_table, as every guard on this regime: V8 refuses a module that mixes it with a legacy try.
      buildStandardTryTable(
        { kind: "empty" },
        [
          ...allocate,
          ...seed,
          ...realmFamilySeed(d),
          { op: "i32.const", value: 2 },
          { op: "global.set", index: d.state },
        ],
        [
          {
            kind: "catch",
            tagIdx: d.exceptionTag,
            payloadType: { kind: "externref" },
            body: [
              { op: "i32.const", value: -1 },
              { op: "global.set", index: d.state },
              { op: "throw", tagIdx: d.exceptionTag },
            ],
          },
        ],
      ),
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
/**
 * %Function.prototype% answers `undefined`, %ThrowTypeError% throws its TypeError; (#7354 P1) an Object.prototype
 * method called through a value is the run-time abort: its algorithm needs the program's ToPropertyKey, so the
 * Prepared path writes it where a call reads the method (`dynamic-prototype-methods.ts`); (#7354 G1) so is a family
 * member (an Error constructor's ToString(message) is the program's, `dynamic-realm-constructors.ts`).
 */
export function buildBuiltinFunctionAlgorithmDefinition(
  d: BuiltinFunctionBodyOperands,
  behavior: BuiltinFunctionEntryOperands["behavior"],
): BuiltinFunctionDefinition {
  const body: Instr[] =
    behavior === "function-prototype"
      ? builtinUndefined(d)
      : behavior === "throw-type-error"
        ? builtinFailure(d, 2)
        : [{ op: "unreachable" }];
  return { locals: [], body };
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
  // (#7354 O1) An ordinary object is its own bag, so every own-property role over `bag` is total over the objects a
  // source program holds: its ordinary objects and its function objects.
  const ordinaryBag: Instr[] =
    slot === "bag"
      ? [
          get(0),
          { op: "any.convert_extern" },
          { op: "ref.test", typeIdx: d.objectTypeIdx },
          { op: "if", blockType: { kind: "empty" }, then: [get(0), { op: "return" }] },
        ]
      : [];
  const body: Instr[] = [
    get(0),
    call(d.match),
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: [...ordinaryBag, ...builtinFailure(d)] },
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
  // `match` admitted the value and no builtin singleton is it, so it is a source closure, whose [[Prototype]] is the
  // realm's %Function.prototype% (#7354 C); a source closure has no [[InitialName]].
  if (slot === "prototype")
    body.push(global(d.entries[0]!.singleton), { op: "ref.as_non_null" }, { op: "extern.convert_any" });
  if (slot === "initialName") body.push({ op: "unreachable" });
  return { locals: [], body };
}
