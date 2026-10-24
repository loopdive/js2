// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { FuncHandle, Instr, LocalDef } from "../../../wasm/model/instructions.js";
import type { ArgumentVectorLayout } from "./argument-vector-bodies.js";
import {
  captureInvokerVector,
  cloneInvokerOperand,
  invokerBodyCoordinate,
  invokerBodyOwnData,
} from "./create-list-from-array-like-body.js";

/** Semantic ports, not native-owner evidence. CreateList is bound to all mode;
 * GenericCall preserves unchanged this, every argument, abrupt identity and reentry.
 * UndefinedValue is the genuine language undefined, never externref null.
 */
export interface FunctionPrototypeCallBindings {
  readonly vector: ArgumentVectorLayout;
  readonly newVector: FuncHandle;
  readonly push: FuncHandle;
  readonly isCallable: FuncHandle;
  readonly undefinedValue: FuncHandle;
  readonly genericCall: FuncHandle;
  readonly genericCallVector?: "external" | "typed";
  readonly typeError: FuncHandle;
  readonly exceptionTag: number;
  readonly errorMessage: readonly Instr[];
}
export interface FunctionPrototypeInvokerBindings extends FunctionPrototypeCallBindings {
  readonly isUndefined: FuncHandle;
  readonly isNull: FuncHandle;
  readonly createListFromArrayLike: FuncHandle;
}
export type FunctionPrototypeInvoker = "call" | "apply";

/** ECMA-262 2026 §20.2.3.1/.3. Parameters: target externref, incoming (ref V).
 * Target callability precedes all argument-list observations. The final Call is a tail edge.
 */
export function buildFunctionPrototypeInvokerDefinition(
  method: "call",
  input: FunctionPrototypeCallBindings,
): { locals: LocalDef[]; body: Instr[] };
export function buildFunctionPrototypeInvokerDefinition(
  method: "apply",
  input: FunctionPrototypeInvokerBindings,
): { locals: LocalDef[]; body: Instr[] };
export function buildFunctionPrototypeInvokerDefinition(
  method: FunctionPrototypeInvoker,
  input: FunctionPrototypeCallBindings | FunctionPrototypeInvokerBindings,
): { locals: LocalDef[]; body: Instr[] } {
  if (method !== "call" && method !== "apply") throw new Error("Function invoker body: unknown method");
  const roles = [
    "newVector",
    "push",
    "isCallable",
    "undefinedValue",
    "genericCall",
    "typeError",
    "exceptionTag",
  ] as const;
  const d = Object.fromEntries(
    roles.map((key) => [key, invokerBodyCoordinate(invokerBodyOwnData(input, key), key)]),
  ) as Record<(typeof roles)[number], number>;
  const vector = captureInvokerVector(invokerBodyOwnData(input, "vector"));
  const errorMessage = cloneInvokerOperand(invokerBodyOwnData(input, "errorMessage"), "errorMessage");
  const mode = Object.getOwnPropertyDescriptor(input, "genericCallVector");
  if (mode && (!Object.hasOwn(mode, "value") || !["external", "typed"].includes(mode.value)))
    throw new Error("Function invoker body: invalid genericCallVector");
  if (!mode && "genericCallVector" in input) throw new Error("Function invoker body: inherited genericCallVector");
  const externalCall = mode?.value === "external";
  const castVector: Instr[] = [{ op: "any.convert_extern" }, { op: "ref.cast", typeIdx: vector.objVecTypeIdx }];
  const readArgument = (index: number): Instr[] => [
    { op: "local.get", index: 1 },
    { op: "struct.get", typeIdx: vector.objVecTypeIdx, fieldIdx: 0 },
    { op: "i32.const", value: index },
    { op: "i32.gt_u" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "externref" } },
      then: [
        { op: "local.get", index: 1 },
        { op: "struct.get", typeIdx: vector.objVecTypeIdx, fieldIdx: 1 },
        { op: "i32.const", value: index },
        { op: "array.get", typeIdx: vector.objVecArrTypeIdx },
      ],
      else: [{ op: "call", funcIdx: d.undefinedValue }],
    },
  ];
  const body: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: d.isCallable },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [...errorMessage, { op: "call", funcIdx: d.typeError }, { op: "throw", tagIdx: d.exceptionTag }],
    },
    ...readArgument(0),
    { op: "local.set", index: 2 },
  ];
  if (method === "call") {
    body.push(
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: vector.objVecTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 4 },
      { op: "call", funcIdx: d.newVector },
      { op: "local.set", index: 3 },
      { op: "i32.const", value: 1 },
      { op: "local.set", index: 5 },
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              { op: "local.get", index: 5 },
              { op: "local.get", index: 4 },
              { op: "i32.ge_u" },
              { op: "br_if", depth: 1 },
              { op: "local.get", index: 3 },
              { op: "local.get", index: 1 },
              { op: "struct.get", typeIdx: vector.objVecTypeIdx, fieldIdx: 1 },
              { op: "local.get", index: 5 },
              { op: "array.get", typeIdx: vector.objVecArrTypeIdx },
              { op: "call", funcIdx: d.push },
              { op: "local.get", index: 5 },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: 5 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      { op: "local.get", index: 0 },
      { op: "local.get", index: 2 },
      { op: "local.get", index: 3 },
      ...(externalCall ? [] : castVector),
      { op: "return_call", funcIdx: d.genericCall },
    );
    return {
      locals: [
        { name: "$this", type: { kind: "externref" } },
        { name: "$output", type: { kind: "externref" } },
        { name: "$length", type: { kind: "i32" } },
        { name: "$index", type: { kind: "i32" } },
      ],
      body,
    };
  }
  const apply = Object.fromEntries(
    (["isUndefined", "isNull", "createListFromArrayLike"] as const).map((key) => [
      key,
      invokerBodyCoordinate(invokerBodyOwnData(input, key), key),
    ]),
  );
  body.push(
    ...readArgument(1),
    { op: "local.set", index: 3 },
    { op: "local.get", index: 3 },
    { op: "call", funcIdx: apply.isUndefined! },
    { op: "local.get", index: 3 },
    { op: "call", funcIdx: apply.isNull! },
    { op: "i32.or" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "ref", typeIdx: vector.objVecTypeIdx } },
      then: [{ op: "call", funcIdx: d.newVector }, ...castVector],
      else: [
        { op: "local.get", index: 3 },
        { op: "call", funcIdx: apply.createListFromArrayLike! },
      ],
    },
    { op: "local.set", index: 4 },
    { op: "local.get", index: 0 },
    { op: "local.get", index: 2 },
    { op: "local.get", index: 4 },
    { op: "ref.as_non_null" },
    ...(externalCall ? [{ op: "extern.convert_any" } as Instr] : []),
    { op: "return_call", funcIdx: d.genericCall },
  );
  return {
    locals: [
      { name: "$this", type: { kind: "externref" } },
      { name: "$argArray", type: { kind: "externref" } },
      { name: "$output", type: { kind: "ref_null", typeIdx: vector.objVecTypeIdx } },
    ],
    body,
  };
}
