// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr, LocalDef } from "../../../wasm/model/instructions.js";
import { CLASS_CONSTRUCT_CLOSURE_FIELD } from "./class-constructor-layouts.js";
import { CLOSURE_FUNC_FIELD_IDX } from "./closure-layouts.js";
import { buildClosureMethodCallBody } from "./closure-invocation-bodies.js";
import {
  buildClosureInvocationBoundary,
  buildClosureInvocationFailure,
  type ClosureInvocationFailure,
  type ClosureInvocationState,
  type NativeClosureMethodEntry,
} from "./closure-method-body.js";

/** Internal [[Construct]] code receives newTarget/argv directly, outside public argument conversion. */
export function buildNativeClassConstructDefinition(
  classType: number,
  rootType: number,
  entries: readonly Pick<NativeClosureMethodEntry, "allocationTypeIdx" | "selfTypeIdx" | "funcTypeIdx">[],
  state: ClosureInvocationState,
  failure: ClosureInvocationFailure,
): { readonly locals: LocalDef[]; readonly body: Instr[] } {
  const classLocal = 3,
    closureLocal = 4,
    funcLocal = 5;
  const slots = { previousThis: 6, previousArgc: 7, previousExtras: 8, result: 9 };
  const neutral: Instr[] = [
    { op: "global.get", index: state.undefinedGlobal },
    { op: "extern.convert_any" },
    { op: "global.set", index: state.currentThis },
    { op: "i32.const", value: -1 },
    { op: "global.set", index: state.argc },
    { op: "ref.null", typeIdx: state.extrasVecTypeIdx },
    { op: "global.set", index: state.extrasArgv },
  ];
  let dispatch = buildClosureInvocationFailure(failure);
  for (const entry of [...entries].reverse()) {
    dispatch = [
      { op: "local.get", index: closureLocal },
      { op: "ref.test", typeIdx: entry.allocationTypeIdx },
      { op: "local.get", index: funcLocal },
      { op: "ref.test", typeIdx: entry.funcTypeIdx },
      { op: "i32.and" },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "externref" } },
        then: buildClosureMethodCallBody(entry, closureLocal, funcLocal, neutral, [
          { op: "local.get", index: 1 },
          { op: "local.get", index: 2 },
        ]),
        else: dispatch,
      },
    ];
  }
  const body: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "local.tee", index: classLocal },
    { op: "ref.test", typeIdx: classType },
    { op: "local.get", index: 1 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: classType },
    { op: "i32.and" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "externref" } },
      then: [
        { op: "local.get", index: classLocal },
        { op: "ref.cast", typeIdx: classType },
        { op: "struct.get", typeIdx: classType, fieldIdx: CLASS_CONSTRUCT_CLOSURE_FIELD },
        { op: "local.tee", index: closureLocal },
        { op: "ref.cast", typeIdx: rootType },
        { op: "struct.get", typeIdx: rootType, fieldIdx: CLOSURE_FUNC_FIELD_IDX },
        { op: "local.set", index: funcLocal },
        ...dispatch,
      ],
      else: buildClosureInvocationFailure(failure),
    },
  ];
  return {
    locals: [
      { name: "__class", type: { kind: "anyref" } },
      { name: "__construct", type: { kind: "anyref" } },
      { name: "__funcref", type: { kind: "funcref" } },
      { name: "__previous_this", type: { kind: "externref" } },
      { name: "__previous_argc", type: { kind: "i32" } },
      { name: "__previous_extras", type: { kind: "ref_null", typeIdx: state.extrasVecTypeIdx } },
      { name: "__result", type: { kind: "externref" } },
    ],
    body: buildClosureInvocationBoundary(state, slots, body),
  };
}
