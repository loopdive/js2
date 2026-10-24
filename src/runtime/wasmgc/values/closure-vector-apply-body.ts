// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { buildBuiltinCarrierRejection } from "./closure-callable-body.js";
import type { Instr, LocalDef } from "../../../wasm/model/instructions.js";
import type { ClosureInvocationLayout } from "./closure-invocation-types.js";
import { buildClosureFuncrefExtraction, buildClosureMethodCallBody } from "./closure-invocation-bodies.js";
import { buildClosureMethodArgument } from "./closure-argument-bodies.js";
import { buildClosureResultBody } from "./closure-result-bodies.js";
import { buildInstallableClosureReceiver } from "./closure-receiver-bodies.js";
import {
  buildClosureInvocationBoundary,
  buildClosureInvocationFailure,
  buildNativeClosureMethodMatch,
  type ClosureInvocationFailure,
  type ClosureInvocationState,
  type NativeClosureMethodEntry,
} from "./closure-method-body.js";

/** Same argc/extras protocol as direct methods, with an actual run-time vector length. */
function argumentState(
  formalCount: number,
  state: ClosureInvocationState,
  length: number,
  data: number,
  inputArrayTypeIdx: number,
  extras: number,
): Instr[] {
  return [
    { op: "local.get", index: length },
    { op: "i32.const", value: formalCount },
    { op: "i32.lt_u" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [{ op: "local.get", index: length }],
      else: [{ op: "i32.const", value: formalCount }],
    },
    { op: "global.set", index: state.argc },
    { op: "local.get", index: length },
    { op: "i32.const", value: formalCount },
    { op: "i32.gt_u" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "ref_null", typeIdx: state.extrasVecTypeIdx } },
      then: [
        { op: "local.get", index: length },
        { op: "i32.const", value: formalCount },
        { op: "i32.sub" },
        { op: "array.new_default", typeIdx: state.extrasArrTypeIdx },
        { op: "local.set", index: extras },
        { op: "local.get", index: extras },
        { op: "ref.as_non_null" },
        { op: "i32.const", value: 0 },
        { op: "local.get", index: data },
        { op: "ref.as_non_null" },
        { op: "i32.const", value: formalCount },
        { op: "local.get", index: length },
        { op: "i32.const", value: formalCount },
        { op: "i32.sub" },
        { op: "array.copy", dstTypeIdx: state.extrasArrTypeIdx, srcTypeIdx: inputArrayTypeIdx },
        { op: "local.get", index: length },
        { op: "i32.const", value: formalCount },
        { op: "i32.sub" },
        { op: "local.get", index: extras },
        { op: "ref.as_non_null" },
        { op: "struct.new", typeIdx: state.extrasVecTypeIdx },
      ],
      else: [{ op: "ref.null", typeIdx: state.extrasVecTypeIdx }],
    },
    { op: "global.set", index: state.extrasArgv },
  ];
}

/**
 * Internal apply on the issued argument-vector carrier, not a generic JavaScript
 * array-like implementation. Typed inputs certify the carrier at the boundary;
 * external runtime inputs are checked against their issued carrier before access.
 * Generic length/index access remains the property owner's separate obligation.
 */
export function buildNativeClosureVectorApplyDefinition(
  layout: ClosureInvocationLayout,
  entries: readonly NativeClosureMethodEntry[],
  state: ClosureInvocationState,
  failure: ClosureInvocationFailure,
  input: {
    readonly vectorTypeIdx: number;
    readonly arrayTypeIdx: number;
    readonly external?: boolean;
    /** Same producer's identity matcher and (callee, receiver, ref argv) caller. */
    readonly receiverVector?: {
      readonly match: number;
      readonly call: number;
      /** Issued builtin carriers must never fall through into positional source calls. */
      readonly carriers: readonly number[];
    };
  },
): { readonly locals: LocalDef[]; readonly body: Instr[] } {
  const anyLocal = 3,
    funcLocal = 4,
    length = 5,
    data = 6,
    extras = 7;
  const slots = { previousThis: 8, previousArgc: 9, previousExtras: 10, result: 11 };
  const argumentBase = 12;
  const maxArguments = Math.max(0, ...entries.map((entry) => entry.params.length));
  const argumentLocals = Array.from({ length: maxArguments }, (_, index) => argumentBase + index);
  let dispatch = buildClosureInvocationFailure(failure);
  for (const entry of [...entries].reverse()) {
    const args = entry.params.flatMap((type, index) =>
      buildClosureMethodArgument(argumentLocals[index]!, index, type, state.argc, entry.arguments),
    );
    const call = buildClosureMethodCallBody(
      entry,
      anyLocal,
      funcLocal,
      argumentState(entry.closureArity, state, length, data, input.arrayTypeIdx, extras),
      args,
    );
    call.push(...buildClosureResultBody(entry.result));
    dispatch = [
      ...buildNativeClosureMethodMatch(entry, anyLocal, funcLocal, argumentLocals),
      { op: "if", blockType: { kind: "val", type: { kind: "externref" } }, then: call, else: dispatch },
    ];
  }
  const readArguments = argumentLocals.flatMap((local, index): Instr[] => [
    { op: "local.get", index: length },
    { op: "i32.const", value: index },
    { op: "i32.gt_u" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "externref" } },
      then: [
        { op: "local.get", index: data },
        { op: "ref.as_non_null" },
        { op: "i32.const", value: index },
        { op: "array.get", typeIdx: input.arrayTypeIdx },
      ],
      else: [{ op: "global.get", index: state.undefinedGlobal }, { op: "extern.convert_any" }],
    },
    { op: "local.set", index: local },
  ]);
  const vector = (): Instr[] => [
    { op: "local.get", index: 2 },
    ...(input.external
      ? ([{ op: "any.convert_extern" }, { op: "ref.cast", typeIdx: input.vectorTypeIdx }] as Instr[])
      : ([{ op: "ref.as_non_null" }] as Instr[])),
  ];
  return {
    locals: [
      { name: "__callee", type: { kind: "anyref" } },
      { name: "__funcref", type: { kind: "funcref" } },
      { name: "__length", type: { kind: "i32" } },
      { name: "__data", type: { kind: "ref_null", typeIdx: input.arrayTypeIdx } },
      { name: "__extras", type: { kind: "ref_null", typeIdx: state.extrasArrTypeIdx } },
      { name: "__previous_this", type: { kind: "externref" } },
      { name: "__previous_argc", type: { kind: "i32" } },
      { name: "__previous_extras", type: { kind: "ref_null", typeIdx: state.extrasVecTypeIdx } },
      { name: "__result", type: { kind: "externref" } },
      ...argumentLocals.map((_, index): LocalDef => ({ name: `__arg${index}`, type: { kind: "externref" } })),
    ],
    body: [
      ...(input.external
        ? ([
            { op: "local.get", index: 2 },
            { op: "any.convert_extern" },
            { op: "ref.test", typeIdx: input.vectorTypeIdx },
            { op: "i32.eqz" },
            { op: "if", blockType: { kind: "empty" }, then: buildClosureInvocationFailure(failure) },
          ] as Instr[])
        : []),
      ...(input.receiverVector
        ? ([
            { op: "local.get", index: 0 },
            { op: "call", funcIdx: input.receiverVector.match },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: 0 },
                { op: "local.get", index: 1 },
                ...vector(),
                { op: "call", funcIdx: input.receiverVector.call },
                { op: "return" },
              ],
            },
            ...buildBuiltinCarrierRejection(input.receiverVector.carriers, 0, buildClosureInvocationFailure(failure)),
          ] satisfies Instr[])
        : []),
      ...buildClosureInvocationBoundary(state, slots, [
        ...(state.receiverPolicy === "exact"
          ? [{ op: "local.get", index: 1 } as Instr]
          : buildInstallableClosureReceiver(1, state.anyValueTypeIdx)),
        { op: "global.set", index: state.currentThis },
        { op: "local.get", index: 2 },
        { op: "ref.is_null" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "i32.const", value: 0 },
            { op: "local.set", index: length },
          ],
          else: [
            ...vector(),
            { op: "struct.get", typeIdx: input.vectorTypeIdx, fieldIdx: 0 },
            { op: "local.set", index: length },
            ...vector(),
            { op: "struct.get", typeIdx: input.vectorTypeIdx, fieldIdx: 1 },
            { op: "local.set", index: data },
          ],
        },
        ...readArguments,
        { op: "local.get", index: 0 },
        { op: "any.convert_extern" },
        { op: "local.set", index: anyLocal },
        ...buildClosureFuncrefExtraction(layout, entries, anyLocal, funcLocal),
        ...dispatch,
      ]),
    ],
  };
}
