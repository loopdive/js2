// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { FuncHandle, Instr, LocalDef, TypeHandle, ValType } from "../../../wasm/model/instructions.js";
import { PROMISE_STATE_PENDING, PROMISE_STATE_FULFILLED, PROMISE_STATE_REJECTED } from "./settlement-bodies.js";

export interface CombinatorCaptureTypes {
  readonly elemCapsTypeIdx: TypeHandle;
  readonly stateTypeIdx: TypeHandle;
}

export interface CombinatorSubscriptionDispatchResources extends CombinatorCaptureTypes {
  readonly promiseTypeIdx: TypeHandle;
  readonly callbackTypeIdx: TypeHandle;
  readonly enqueueFuncIdx: FuncHandle;
  readonly markRejectionHandledFuncIdx: FuncHandle | undefined;
}

export interface CombinatorSubscriptionResources extends CombinatorSubscriptionDispatchResources {
  readonly resolveValueFuncIdx: FuncHandle;
  readonly bagInit: { readonly op: "ref.null.extern" };
}

export interface CombinatorAllFulfillResources extends CombinatorCaptureTypes {
  readonly arrTypeIdx: TypeHandle;
  readonly vecTypeIdx: TypeHandle;
  readonly fulfillFuncIdx: FuncHandle;
}

export interface NativePromiseCombinatorVectorLocals {
  readonly argVecLocal: number;
  readonly resultLocal: number;
  readonly arrLocal: number;
  readonly stateLocal: number;
  readonly nLocal: number;
  readonly iLocal: number;
}

export interface NativePromiseCombinatorVectorResources {
  readonly promiseTypeIdx: TypeHandle;
  readonly stateTypeIdx: TypeHandle;
  readonly arrTypeIdx: TypeHandle;
  readonly vecTypeIdx: TypeHandle;
  readonly argVecTypeIdx: TypeHandle;
  readonly argArrTypeIdx: TypeHandle;
  readonly subscribeFuncIdx: FuncHandle;
  readonly fulfillReactionFuncIdx: FuncHandle;
  readonly rejectReactionFuncIdx: FuncHandle;
  readonly fulfillFuncIdx: FuncHandle;
  readonly rejectFuncIdx: FuncHandle;
  readonly bagInit: { readonly op: "ref.null.extern" };
  readonly emptyResult:
    | { readonly kind: "fulfill-vector" }
    | { readonly kind: "pending" }
    | { readonly kind: "reject-aggregate"; readonly aggregateErrorFuncIdx: FuncHandle };
}

const EXTERNREF: ValType = { kind: "externref" };

// ── __combinator_subscribe ───────────────────────────────────────────────────
// params: 0 input externref, 1 state externref, 2 index i32, 3 fulfillFn funcref,
//         4 rejectFn funcref. locals: 5 p (ref $Promise), 6 caps externref.

export function buildSubscribeLocals(promiseTypeIdx: TypeHandle): LocalDef[] {
  return [
    { name: "$p", type: { kind: "ref", typeIdx: promiseTypeIdx } },
    { name: "$caps", type: EXTERNREF },
  ];
}

export function buildSubscribeBody(ids: CombinatorSubscriptionResources): Instr[] {
  if (!Number.isInteger(ids.resolveValueFuncIdx) || ids.resolveValueFuncIdx < 0) {
    throw new Error("native combinator subscription requires a resolved resolve-value function handle");
  }
  const INPUT = 0;
  const P = 5;
  return [
    // Normalize `input` to a `$Promise`. A native `$Promise` passes through; any
    // other value is wrapped in a synchronously-FULFILLED `$Promise` so the
    // dispatch below is uniform (mirrors spec PromiseResolve for a non-thenable).
    { op: "local.get", index: INPUT },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: ids.promiseTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: INPUT },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: ids.promiseTypeIdx },
        { op: "local.set", index: P },
      ],
      // (#5143 Step 1a) Spec PromiseResolve(C, x): allocate a fresh
      else:
        // PENDING `$Promise` and drive it through
        // `__promise_resolve_value`, which implements §27.2.1.3.2 in full
        // — a user THENABLE element gets a PromiseResolveThenableJob on
        // the microtask ring (its `then` is actually invoked), a poisoned
        // `then` getter rejects, and a plain value still fulfils
        // synchronously (same observable result as the old sync-FULFILLED
        // wrap, one extra struct + call).
        [
          { op: "i32.const", value: PROMISE_STATE_PENDING },
          { op: "ref.null.extern" },
          { op: "ref.null.extern" },
          { op: ids.bagInit.op },
          { op: "struct.new", typeIdx: ids.promiseTypeIdx },
          { op: "local.set", index: P },
          { op: "local.get", index: P },
          { op: "local.get", index: INPUT },
          { op: "call", funcIdx: ids.resolveValueFuncIdx },
          { op: "drop" },
        ] satisfies Instr[],
    },

    ...buildSubscribeDispatchBody(ids),
  ];
}

export function buildSubscribeDispatchBody(ids: CombinatorSubscriptionDispatchResources): Instr[] {
  const STATE = 1;
  const INDEX = 2;
  const FULFILL_FN = 3;
  const REJECT_FN = 4;
  const P = 5;
  const CAPS = 6;
  const cbTypeIdx = ids.callbackTypeIdx;
  return [
    // caps = $CombinatorElemCaps{ state, index } (boxed to externref).
    { op: "local.get", index: STATE },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: ids.stateTypeIdx },
    { op: "local.get", index: INDEX },
    { op: "struct.new", typeIdx: ids.elemCapsTypeIdx },
    { op: "extern.convert_any" },
    { op: "local.set", index: CAPS },

    // (#2958) Subscribing to this input attaches a reaction — the combinator is
    // now handling its (possible) rejection, so clear its unhandled flag. Covers
    // an inlined `Promise.reject(x)` element that would otherwise be reported as
    // unhandled even though the combinator consumes it. No-op when inactive.
    ...(ids.markRejectionHandledFuncIdx !== undefined
      ? ([
          { op: "local.get", index: P },
          { op: "call", funcIdx: ids.markRejectionHandledFuncIdx },
        ] satisfies Instr[])
      : []),

    // Dispatch on the (possibly already-settled) promise state.
    { op: "local.get", index: P },
    { op: "struct.get", typeIdx: ids.promiseTypeIdx, fieldIdx: 0 },
    { op: "i32.const", value: PROMISE_STATE_FULFILLED },
    { op: "i32.eq" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        // enqueue(fulfillFn, caps, p.value)
        { op: "local.get", index: FULFILL_FN },
        { op: "local.get", index: CAPS },
        { op: "local.get", index: P },
        { op: "struct.get", typeIdx: ids.promiseTypeIdx, fieldIdx: 1 },
        { op: "call", funcIdx: ids.enqueueFuncIdx },
      ],
      else: [
        { op: "local.get", index: P },
        { op: "struct.get", typeIdx: ids.promiseTypeIdx, fieldIdx: 0 },
        { op: "i32.const", value: PROMISE_STATE_REJECTED },
        { op: "i32.eq" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            // enqueue(rejectFn, caps, p.value)
            { op: "local.get", index: REJECT_FN },
            { op: "local.get", index: CAPS },
            { op: "local.get", index: P },
            { op: "struct.get", typeIdx: ids.promiseTypeIdx, fieldIdx: 1 },
            { op: "call", funcIdx: ids.enqueueFuncIdx },
          ],
          else: [
            // pending: prepend a reaction node onto p.callbacks.
            { op: "local.get", index: P },
            { op: "local.get", index: FULFILL_FN },
            { op: "local.get", index: CAPS },
            { op: "local.get", index: REJECT_FN },
            { op: "local.get", index: CAPS },
            { op: "local.get", index: P },
            { op: "struct.get", typeIdx: ids.promiseTypeIdx, fieldIdx: 2 },
            { op: "struct.new", typeIdx: cbTypeIdx },
            { op: "extern.convert_any" },
            { op: "struct.set", typeIdx: ids.promiseTypeIdx, fieldIdx: 2 },
          ],
        },
      ],
    },
  ];
}

// ── __combinator_all_fulfill ─────────────────────────────────────────────────
// params: 0 caps externref, 1 value externref.
// locals: 2 c (ref $CombinatorElemCaps), 3 st (ref $CombinatorState), 4 rem i32.

export function buildAllFulfillLocals(ids: CombinatorCaptureTypes): LocalDef[] {
  return [
    { name: "$c", type: { kind: "ref", typeIdx: ids.elemCapsTypeIdx } },
    { name: "$st", type: { kind: "ref", typeIdx: ids.stateTypeIdx } },
    { name: "$rem", type: { kind: "i32" } },
  ];
}

export function buildAllFulfillBody(ids: CombinatorAllFulfillResources): Instr[] {
  const CAPS = 0;
  const VALUE = 1;
  const C = 2;
  const ST = 3;
  const REM = 4;
  return [
    { op: "local.get", index: CAPS },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: ids.elemCapsTypeIdx },
    { op: "local.set", index: C },
    { op: "local.get", index: C },
    { op: "struct.get", typeIdx: ids.elemCapsTypeIdx, fieldIdx: 0 },
    { op: "local.set", index: ST },

    // results[index] = value
    { op: "local.get", index: ST },
    { op: "struct.get", typeIdx: ids.stateTypeIdx, fieldIdx: 1 },
    { op: "local.get", index: C },
    { op: "struct.get", typeIdx: ids.elemCapsTypeIdx, fieldIdx: 1 },
    { op: "local.get", index: VALUE },
    { op: "array.set", typeIdx: ids.arrTypeIdx },

    // remaining -= 1
    { op: "local.get", index: ST },
    { op: "local.get", index: ST },
    { op: "struct.get", typeIdx: ids.stateTypeIdx, fieldIdx: 3 },
    { op: "i32.const", value: 1 },
    { op: "i32.sub" },
    { op: "local.tee", index: REM },
    { op: "struct.set", typeIdx: ids.stateTypeIdx, fieldIdx: 3 },

    // if remaining == 0: fulfill the result promise with the results vec.
    { op: "local.get", index: REM },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: ST },
        { op: "struct.get", typeIdx: ids.stateTypeIdx, fieldIdx: 0 },
        // vec = struct.new $vec(length, resultsArr)
        { op: "local.get", index: ST },
        { op: "struct.get", typeIdx: ids.stateTypeIdx, fieldIdx: 2 },
        { op: "local.get", index: ST },
        { op: "struct.get", typeIdx: ids.stateTypeIdx, fieldIdx: 1 },
        { op: "struct.new", typeIdx: ids.vecTypeIdx },
        { op: "extern.convert_any" },
        { op: "call", funcIdx: ids.fulfillFuncIdx },
        { op: "drop" },
      ],
    },

    { op: "local.get", index: VALUE },
  ];
}

// ── __combinator_race_fulfill / __combinator_reject ──────────────────────────
// params: 0 caps externref, 1 value externref. locals: 2 c, 3 st.

export function buildSettleWrapperLocals(ids: CombinatorCaptureTypes): LocalDef[] {
  return [
    { name: "$c", type: { kind: "ref", typeIdx: ids.elemCapsTypeIdx } },
    { name: "$st", type: { kind: "ref", typeIdx: ids.stateTypeIdx } },
  ];
}

export function buildSettleResultBody(ids: CombinatorCaptureTypes, settleFuncIdx: FuncHandle): Instr[] {
  const CAPS = 0;
  const VALUE = 1;
  const C = 2;
  const ST = 3;
  // Settle (fulfill for race, reject for both all & race) the shared result
  // promise with `value`. Settlement is one-shot, so a second settle no-ops —
  // exactly the "first wins" (race) / "first rejection wins" (all) semantics.
  return [
    { op: "local.get", index: CAPS },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: ids.elemCapsTypeIdx },
    { op: "local.set", index: C },
    { op: "local.get", index: C },
    { op: "struct.get", typeIdx: ids.elemCapsTypeIdx, fieldIdx: 0 },
    { op: "local.set", index: ST },
    { op: "local.get", index: ST },
    { op: "struct.get", typeIdx: ids.stateTypeIdx, fieldIdx: 0 },
    { op: "local.get", index: VALUE },
    { op: "call", funcIdx: settleFuncIdx },
    // __promise_fulfill/__promise_reject return the settled value — that is the
    // wrapper's externref result, so leave it on the stack.
  ];
}

export function buildRaceFulfillBody(ids: CombinatorCaptureTypes, fulfillFuncIdx: FuncHandle): Instr[] {
  return buildSettleResultBody(ids, fulfillFuncIdx);
}

export function buildRejectBody(ids: CombinatorCaptureTypes, rejectFuncIdx: FuncHandle): Instr[] {
  return buildSettleResultBody(ids, rejectFuncIdx);
}

/** Detached instructions; registrations and local ownership remain with the caller. */
export function buildNativePromiseCombinatorVectorBody(
  ids: NativePromiseCombinatorVectorResources,
  locals: NativePromiseCombinatorVectorLocals,
  opts?: { readonly notIterLocal: number; readonly rejectReason: readonly Instr[] },
): Instr[] {
  const { argVecLocal, resultLocal, arrLocal, stateLocal, nLocal, iLocal } = locals;
  const { argVecTypeIdx, argArrTypeIdx } = ids;
  const body: Instr[] = [];
  // n = argVec.length — the vec's LOGICAL length (field 0), not the backing
  // array's capacity (`array.len` over-reports after push growth).
  body.push({ op: "local.get", index: argVecLocal });
  body.push({ op: "ref.as_non_null" });
  body.push({ op: "struct.get", typeIdx: argVecTypeIdx, fieldIdx: 0 });
  body.push({ op: "local.set", index: nLocal });

  // Pending result promise.
  body.push({ op: "i32.const", value: PROMISE_STATE_PENDING });
  body.push({ op: "ref.null.extern" });
  body.push({ op: "ref.null.extern" });
  body.push({ op: ids.bagInit.op });
  body.push({ op: "struct.new", typeIdx: ids.promiseTypeIdx });
  body.push({ op: "local.set", index: resultLocal });

  // Backing results array sized n (only meaningful for `all`; `race` ignores it).
  body.push({ op: "local.get", index: nLocal });
  body.push({ op: "array.new_default", typeIdx: ids.arrTypeIdx });
  body.push({ op: "local.set", index: arrLocal });

  // $CombinatorState{ resultPromise, resultsArr, length=n, remaining=n }.
  body.push({ op: "local.get", index: resultLocal });
  body.push({ op: "local.get", index: arrLocal });
  body.push({ op: "local.get", index: nLocal });
  body.push({ op: "local.get", index: nLocal });
  body.push({ op: "struct.new", typeIdx: ids.stateTypeIdx });
  body.push({ op: "local.set", index: stateLocal });

  // (#2922) Dynamic-argument mode: a not-iterable argument settles the result
  // promise REJECTED with a TypeError (§27.2.4.1 step 3 / IfAbruptRejectPromise).
  // Emitted BEFORE the `all` empty-vec fulfill so the one-shot settle makes the
  // fulfill a no-op (argVecLocal holds an empty vec in this case, so n == 0).
  if (opts) {
    body.push({ op: "local.get", index: opts.notIterLocal });
    body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: resultLocal },
        ...opts.rejectReason,
        { op: "call", funcIdx: ids.rejectFuncIdx },
        { op: "drop" },
      ],
    });
  }

  // `Promise.all(<empty>)` / `Promise.allSettled(<empty>)` fulfill immediately
  // with the empty results vec; `Promise.any(<empty>)` rejects immediately with
  // an empty-`.errors` AggregateError (one-shot settle keeps the opts
  // not-iterable TypeError reject above authoritative when both fire);
  // `Promise.race(<empty>)` stays pending forever (spec). The subscribe loop
  // below runs zero iterations either way.
  if (ids.emptyResult.kind === "fulfill-vector") {
    body.push({ op: "local.get", index: nLocal });
    body.push({ op: "i32.eqz" });
    body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: resultLocal },
        { op: "i32.const", value: 0 },
        { op: "local.get", index: arrLocal },
        { op: "struct.new", typeIdx: ids.vecTypeIdx },
        { op: "extern.convert_any" },
        { op: "call", funcIdx: ids.fulfillFuncIdx },
        { op: "drop" },
      ],
    });
  } else if (ids.emptyResult.kind === "reject-aggregate") {
    body.push({ op: "local.get", index: nLocal });
    body.push({ op: "i32.eqz" });
    body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: resultLocal },
        { op: "i32.const", value: 0 },
        { op: "local.get", index: arrLocal },
        { op: "struct.new", typeIdx: ids.vecTypeIdx },
        { op: "extern.convert_any" },
        { op: "call", funcIdx: ids.emptyResult.aggregateErrorFuncIdx },
        { op: "call", funcIdx: ids.rejectFuncIdx },
        { op: "drop" },
      ],
    });
  }

  // for (i = 0; i < n; i++) __combinator_subscribe(argVec.data[i], state, i,
  //                                                fulfillFn, rejectFn)
  // Subscribe never settles synchronously (already-settled inputs only ENQUEUE),
  // so `remaining` stays == n through the whole loop — no mid-loop settle race.
  body.push({ op: "i32.const", value: 0 });
  body.push({ op: "local.set", index: iLocal });
  body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [
      {
        op: "loop",
        blockType: { kind: "empty" },
        body: [
          { op: "local.get", index: iLocal },
          { op: "local.get", index: nLocal },
          { op: "i32.ge_s" },
          // depth 1: exit the enclosing block (skip the loop label).
          { op: "br_if", depth: 1 },

          // element: argVec.data[i] — externref, subscribe's input directly.
          { op: "local.get", index: argVecLocal },
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: argVecTypeIdx, fieldIdx: 1 },
          { op: "local.get", index: iLocal },
          { op: "array.get", typeIdx: argArrTypeIdx },
          { op: "local.get", index: stateLocal },
          { op: "extern.convert_any" },
          { op: "local.get", index: iLocal },
          { op: "ref.func", funcIdx: ids.fulfillReactionFuncIdx },
          { op: "ref.func", funcIdx: ids.rejectReactionFuncIdx },
          { op: "call", funcIdx: ids.subscribeFuncIdx },

          // i++
          { op: "local.get", index: iLocal },
          { op: "i32.const", value: 1 },
          { op: "i32.add" },
          { op: "local.set", index: iLocal },
          // depth 0: re-enter the loop label.
          { op: "br", depth: 0 },
        ],
      },
    ],
  });

  body.push({ op: "local.get", index: resultLocal });
  body.push({ op: "extern.convert_any" });
  return body;
}
