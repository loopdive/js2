// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { FuncHandle, Instr, LocalDef, ValType } from "../../../wasm/model/instructions.js";
import type { ClosureInvocationArityEntry, ClosureInvocationLayout } from "./closure-invocation-types.js";
import {
  buildClosureFuncrefExtraction,
  buildClosureMethodArgumentState,
  buildClosureMethodCallBody,
  type ClosureArgumentState,
} from "./closure-invocation-bodies.js";
import { buildClosureMethodArgument, type ClosureArgumentConversion } from "./closure-argument-bodies.js";
import { buildClosureResultBody, type ClosureResultConversion } from "./closure-result-bodies.js";
import { buildInstallableClosureReceiver } from "./closure-receiver-bodies.js";

export interface NativeClosureMethodEntry extends ClosureInvocationArityEntry {
  /** Exact selected allocation carrier, including capture or builtin metadata identity. */
  readonly allocationTypeIdx: number;
  readonly params: readonly ValType[];
  readonly arguments: ClosureArgumentConversion;
  readonly result: ClosureResultConversion;
}
export interface ClosureInvocationState extends ClosureArgumentState {
  readonly currentThis: number;
  readonly anyValueTypeIdx: number;
  readonly undefinedGlobal: number;
  /** Native strict boundaries retain undefined and null as distinct receivers. */
  readonly receiverPolicy?: "exact" | "legacy-undefined-sentinel";
}
export interface ClosureInvocationFailure {
  readonly message:
    | { readonly kind: "global"; readonly index: number }
    | { readonly kind: "callable"; readonly handle: FuncHandle };
  readonly newTypeError: FuncHandle;
  readonly exceptionTag: number;
}

export function buildClosureInvocationFailure(failure: ClosureInvocationFailure): Instr[] {
  return [
    ...(failure.message.kind === "global"
      ? ([{ op: "global.get", index: failure.message.index }, { op: "extern.convert_any" }] satisfies Instr[])
      : ([{ op: "call", funcIdx: failure.message.handle }] satisfies Instr[])),
    { op: "call", funcIdx: failure.newTypeError },
    { op: "throw", tagIdx: failure.exceptionTag },
  ];
}

/** Save/restore the invocation protocol without converting or replacing a thrown value. */
export function buildClosureInvocationBoundary(
  state: ClosureInvocationState,
  slots: {
    readonly previousThis: number;
    readonly previousArgc: number;
    readonly previousExtras: number;
    readonly result: number;
  },
  body: readonly Instr[],
): Instr[] {
  const restore = (): Instr[] => [
    { op: "local.get", index: slots.previousThis },
    { op: "global.set", index: state.currentThis },
    { op: "local.get", index: slots.previousArgc },
    { op: "global.set", index: state.argc },
    { op: "local.get", index: slots.previousExtras },
    { op: "global.set", index: state.extrasArgv },
  ];
  return [
    { op: "global.get", index: state.currentThis },
    { op: "local.set", index: slots.previousThis },
    { op: "global.get", index: state.argc },
    { op: "local.set", index: slots.previousArgc },
    { op: "global.get", index: state.extrasArgv },
    { op: "local.set", index: slots.previousExtras },
    {
      op: "try",
      blockType: { kind: "empty" },
      body: [...structuredClone([...body]), { op: "local.set", index: slots.result }],
      catches: [],
      catchAll: [...restore(), { op: "rethrow", depth: 0 }],
    },
    ...restore(),
    { op: "local.get", index: slots.result },
  ];
}

export function buildNativeClosureMethodMatch(
  entry: NativeClosureMethodEntry,
  anyLocal: number,
  funcLocal: number,
  argumentLocals: readonly number[],
): Instr[] {
  return [
    { op: "local.get", index: anyLocal },
    { op: "ref.test", typeIdx: entry.allocationTypeIdx },
    { op: "local.get", index: funcLocal },
    { op: "ref.test", typeIdx: entry.funcTypeIdx },
    { op: "i32.and" },
    ...entry.params.flatMap((type, index): Instr[] =>
      type.kind !== "ref"
        ? []
        : [
            { op: "local.get", index: argumentLocals[index]! },
            { op: "any.convert_extern" },
            { op: "ref.test", typeIdx: type.typeIdx },
            { op: "i32.and" },
          ],
    ),
  ];
}

/** Real method dispatch, using the same call/conversion/state policies as the old caller. */
export function buildNativeClosureMethodDefinition(
  arity: number,
  layout: ClosureInvocationLayout,
  entries: readonly NativeClosureMethodEntry[],
  state: ClosureInvocationState,
  failure: ClosureInvocationFailure,
): { readonly locals: LocalDef[]; readonly body: Instr[] } {
  const anyLocal = arity + 2,
    funcLocal = anyLocal + 1;
  const slots = {
    previousThis: anyLocal + 2,
    previousArgc: anyLocal + 3,
    previousExtras: anyLocal + 4,
    result: anyLocal + 5,
  };
  const omittedLocal = anyLocal + 6;
  let dispatch = buildClosureInvocationFailure(failure);
  for (const entry of [...entries].reverse()) {
    const argumentLocals = entry.params.map((_, index) => (index < arity ? index + 2 : omittedLocal));
    const argumentsBody = entry.params.flatMap((type, index) =>
      buildClosureMethodArgument(argumentLocals[index]!, index, type, state.argc, entry.arguments),
    );
    const call = buildClosureMethodCallBody(
      entry,
      anyLocal,
      funcLocal,
      buildClosureMethodArgumentState(arity, entry.closureArity, state),
      argumentsBody,
    );
    call.push(...buildClosureResultBody(entry.result));
    dispatch = [
      ...buildNativeClosureMethodMatch(entry, anyLocal, funcLocal, argumentLocals),
      { op: "if", blockType: { kind: "val", type: { kind: "externref" } }, then: call, else: dispatch },
    ];
  }
  return {
    locals: [
      { name: "__any", type: { kind: "anyref" } },
      { name: "__funcref", type: { kind: "funcref" } },
      { name: "__previous_this", type: { kind: "externref" } },
      { name: "__previous_argc", type: { kind: "i32" } },
      { name: "__previous_extras", type: { kind: "ref_null", typeIdx: state.extrasVecTypeIdx } },
      { name: "__result", type: { kind: "externref" } },
      { name: "__omitted", type: { kind: "externref" } },
    ],
    body: buildClosureInvocationBoundary(state, slots, [
      ...(state.receiverPolicy === "exact"
        ? [{ op: "local.get", index: 0 } as Instr]
        : buildInstallableClosureReceiver(0, state.anyValueTypeIdx)),
      { op: "global.set", index: state.currentThis },
      { op: "global.get", index: state.undefinedGlobal },
      { op: "extern.convert_any" },
      { op: "local.set", index: omittedLocal },
      // A direct method entry owns its actual count. An outer call's marker
      // cannot describe this call; the boundary restores it afterward.
      { op: "i32.const", value: arity },
      { op: "global.set", index: state.argc },
      { op: "local.get", index: 1 },
      { op: "any.convert_extern" },
      { op: "local.set", index: anyLocal },
      ...buildClosureFuncrefExtraction(layout, entries, anyLocal, funcLocal),
      ...dispatch,
    ]),
  };
}
