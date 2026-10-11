// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { LocalDef, TypeHandle } from "../../../wasm/model/instructions.js";
import { closureArityField, closureBagField } from "../values/closure-layouts.js";
import type { NativePromiseCombinatorVectorLocals } from "./combinator-bodies.js";

type Field<N extends string, T, M extends boolean = false> = {
  readonly name: N;
  readonly type: T;
  readonly mutable: M;
};

type DelayFields<R> = readonly [
  Field<"func", { kind: "funcref" }>,
  Field<"$arity", { kind: "i32" }>,
  Field<"$bag", { kind: "externref" }, true>,
  Field<"promise", R>,
  Field<"value", { kind: "f64" }>,
];
type StateFields<R> = readonly [
  Field<"resultPromise", R>,
  Field<"resultsArr", R>,
  Field<"length", { kind: "i32" }>,
  Field<"remaining", { kind: "i32" }, true>,
];
type ElementFields<R> = readonly [Field<"state", R>, Field<"index", { kind: "i32" }>];

export type NativeDelayCaptureField<R> = DelayFields<R>[number];
export type NativeCombinatorStateField<R> = StateFields<R>[number];
export type NativeCombinatorElementField<R> = ElementFields<R>[number];

/** R is a complete reference value, symbolic or physical, never an index projection. */
export function createNativeDelayCaptureShape<R>(
  wrapper: R,
  promise: R,
): {
  readonly name: "$__ir_promise_delay_timer_cap";
  readonly parent: R;
  readonly fields: DelayFields<R>;
} {
  const arity = closureArityField();
  const bag = closureBagField();
  if (arity.name !== "$arity" || bag.name !== "$bag") {
    throw new Error("native delay requires the canonical named closure header");
  }
  return {
    name: "$__ir_promise_delay_timer_cap",
    parent: wrapper,
    fields: [
      { name: "func", type: { kind: "funcref" }, mutable: false },
      { name: arity.name, type: arity.type, mutable: arity.mutable },
      { name: bag.name, type: bag.type, mutable: bag.mutable },
      { name: "promise", type: promise, mutable: false },
      { name: "value", type: { kind: "f64" }, mutable: false },
    ],
  };
}

export function createNativeCombinatorStateShape<R>(
  promise: R,
  resultsArray: R,
): {
  readonly name: "$CombinatorState";
  readonly fields: StateFields<R>;
} {
  return {
    name: "$CombinatorState",
    fields: [
      { name: "resultPromise", type: promise, mutable: false },
      { name: "resultsArr", type: resultsArray, mutable: false },
      { name: "length", type: { kind: "i32" }, mutable: false },
      { name: "remaining", type: { kind: "i32" }, mutable: true },
    ],
  };
}

export function createNativeCombinatorElementShape<R>(state: R): {
  readonly name: "$CombinatorElemCaps";
  readonly fields: ElementFields<R>;
} {
  return {
    name: "$CombinatorElemCaps",
    fields: [
      { name: "state", type: state, mutable: false },
      { name: "index", type: { kind: "i32" }, mutable: false },
    ],
  };
}

/** Describe the five existing allocLocal effects without allocating or retaining a context. */
export function buildNativeAllProviderLocals(
  promiseType: TypeHandle,
  arrayType: TypeHandle,
  stateType: TypeHandle,
  placement: {
    readonly parameterCount: number;
    readonly firstLocalOrdinal: number;
    readonly argVecLocal: number;
  },
): { readonly locals: readonly LocalDef[]; readonly slots: NativePromiseCombinatorVectorLocals } {
  const ordinal = placement.firstLocalOrdinal;
  const first = placement.parameterCount + ordinal;
  return {
    locals: [
      { name: `__comb_result_${ordinal}`, type: { kind: "ref", typeIdx: promiseType } },
      { name: `__comb_arr_${ordinal + 1}`, type: { kind: "ref", typeIdx: arrayType } },
      { name: `__comb_state_${ordinal + 2}`, type: { kind: "ref", typeIdx: stateType } },
      { name: `__comb_n_${ordinal + 3}`, type: { kind: "i32" } },
      { name: `__comb_i_${ordinal + 4}`, type: { kind: "i32" } },
    ],
    slots: {
      argVecLocal: placement.argVecLocal,
      resultLocal: first,
      arrLocal: first + 1,
      stateLocal: first + 2,
      nLocal: first + 3,
      iLocal: first + 4,
    },
  };
}
