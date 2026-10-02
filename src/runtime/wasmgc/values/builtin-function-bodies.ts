// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr, LocalDef, FuncHandle } from "../../../wasm/model/instructions.js";
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
  readonly behavior: "function-prototype" | "throw-type-error";
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
      ...(entry.behavior === "function-prototype"
        ? [global(d.objectPrototype)]
        : [global(d.entries[0]!.singleton), { op: "extern.convert_any" } as Instr]),
      global(d.realm),
      { op: "ref.as_non_null" },
      ...structuredClone(entry.initialName),
      { op: "struct.new", typeIdx: entry.typeIdx },
      { op: "global.set", index: entry.singleton },
    ]),
  ];
  const seed: Instr[] = d.entries.flatMap((entry) => {
    const bag = (): Instr[] => [
      global(entry.singleton),
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: entry.typeIdx, fieldIdx: CLOSURE_BAG_FIELD_IDX },
    ];
    const body: Instr[] = [
      ...bag(),
      ...structuredClone(d.lengthKey),
      { op: "f64.const", value: entry.initialLength },
      call(d.boxNumber),
      { op: "f64.const", value: 0xbc },
      call(d.defineDataBody),
      { op: "drop" },
      ...bag(),
      ...structuredClone(d.nameKey),
      ...structuredClone(entry.initialName),
      { op: "extern.convert_any" },
      { op: "f64.const", value: 0xbc },
      call(d.defineDataBody),
      { op: "drop" },
    ];
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
