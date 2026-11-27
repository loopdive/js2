// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7557) The realm's built-in caller on the runtime side. A built-in function the dispatcher reaches (a closure-root
 * callee that no source closure's arm matched) is run by the program: module-init installs one caller closure
 * (`__builtin_caller`, `src/ir/realm-builtin-caller.ts`), and the dispatcher's built-in arm calls it through method 3
 * with the built-in, the call's `this` and an argument vector of the call's arguments. The caller reads them back
 * (`argument`, `argument-count`). Before the install, or where the program installs none, the arm is the run-time
 * abort it always was.
 */
import type { FuncHandle, Instr, LocalDef } from "../../../wasm/model/instructions.js";
import type { ArgumentVectorLayout } from "./argument-vector-bodies.js";

type Definition = { readonly locals: LocalDef[]; readonly body: Instr[] };

/** The installed caller (`global`) and the dispatcher method of the caller's arity that calls it. */
export interface BuiltinCallerArm {
  readonly global: number;
  readonly method: FuncHandle;
  readonly vector: ArgumentVectorLayout;
}

const vectorOf = (vector: ArgumentVectorLayout, local: number): Instr[] => [
  { op: "local.get", index: local },
  { op: "any.convert_extern" },
  { op: "ref.cast", typeIdx: vector.objVecTypeIdx },
];

/** `install(caller)`: the caller closure into its global. */
export function buildInstallBuiltinCallerDefinition(global: number): Definition {
  return {
    locals: [],
    body: [
      { op: "local.get", index: 0 },
      { op: "global.set", index: global },
    ],
  };
}

/** `argument(vector, index) -> value`: the vector's element `index`, `undefined` past its end. */
export function buildBuiltinArgumentDefinition(vector: ArgumentVectorLayout, undefinedGlobal: number): Definition {
  const index = 2;
  return {
    locals: [{ name: "index", type: { kind: "i32" } }],
    body: [
      { op: "local.get", index: 1 },
      { op: "i32.trunc_sat_f64_u" },
      { op: "local.set", index },
      { op: "local.get", index },
      ...vectorOf(vector, 0),
      { op: "struct.get", typeIdx: vector.objVecTypeIdx, fieldIdx: 0 },
      { op: "i32.lt_u" },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "externref" } },
        then: [
          ...vectorOf(vector, 0),
          { op: "struct.get", typeIdx: vector.objVecTypeIdx, fieldIdx: 1 },
          { op: "local.get", index },
          { op: "array.get", typeIdx: vector.objVecArrTypeIdx },
        ],
        else: [{ op: "global.get", index: undefinedGlobal }, { op: "extern.convert_any" }],
      },
    ],
  };
}

/** `argument-count(vector) -> f64`: the vector's length. */
export function buildBuiltinArgumentCountDefinition(vector: ArgumentVectorLayout): Definition {
  return {
    locals: [],
    body: [
      ...vectorOf(vector, 0),
      { op: "struct.get", typeIdx: vector.objVecTypeIdx, fieldIdx: 0 },
      { op: "f64.convert_i32_u" },
    ],
  };
}

/**
 * Where the closure-root callee in `callee` meets an installed caller: the caller's call (method 3) with the callee,
 * the receiver (`receiver`) and a vector of `argumentLocals`, as an externref; `otherwise` (the arm before the caller)
 * where none is installed.
 */
export function buildBuiltinCallerCall(
  arm: BuiltinCallerArm,
  receiver: Instr[],
  callee: number,
  argumentLocals: readonly number[],
  undefinedGlobal: number,
  otherwise: Instr[],
): Instr[] {
  return [
    { op: "global.get", index: arm.global },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "externref" } },
      then: otherwise,
      else: [
        { op: "global.get", index: undefinedGlobal },
        { op: "extern.convert_any" },
        { op: "global.get", index: arm.global },
        { op: "local.get", index: callee },
        ...receiver,
        { op: "i32.const", value: argumentLocals.length },
        ...argumentLocals.map((index): Instr => ({ op: "local.get", index })),
        { op: "array.new_fixed", typeIdx: arm.vector.objVecArrTypeIdx, length: argumentLocals.length },
        { op: "struct.new", typeIdx: arm.vector.objVecTypeIdx },
        { op: "extern.convert_any" },
        { op: "call", funcIdx: arm.method },
      ],
    },
  ];
}
