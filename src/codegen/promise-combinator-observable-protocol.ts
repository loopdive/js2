// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Main's observable protocol lives outside the source-preserved legacy adapter.
// D2b consumes its preparation/element emitters; the forwarding entrypoints
// retain main's literal/vector opt-in and nullable-support fallback behavior.
// The separate promise-observable-combinators implementation remains independent,
// sharing the successful runtime cache and its resource names with this module.

import type { FieldDef, Instr, ValType } from "../ir/types.js";
import { buildTargetTaggedTry } from "../ir/try-table.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { ensureBuiltinFnMetaType } from "./builtin-fn-meta.js";
import { emitBuiltinConstructorIdentity } from "./builtin-static-globals.js";
import { ensureStandaloneBuiltinStaticMethodClosure } from "./builtin-value-read.js";
import { reserveCarrierBagVisibility } from "./carrier-bag-visibility.js";
import { buildClosureRefTestArms } from "./closure-classifier.js";
import { closureBagInitInstr, getOrCreateFuncRefWrapperTypes } from "./closures/funcref-wrapper-types.js";
import { ensureObjVecBuilders, ensureObjectRuntime, reserveApplyClosure } from "./object-runtime.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { emitWasiErrorConstructor } from "./registry/error-types.js";
import { addStringConstantGlobal, ensureExnTag } from "./registry/imports.js";
import { getArrTypeIdxFromVec } from "./registry/types.js";
import {
  ensureCombinatorFunctions,
  emitStandalonePromiseCombinator as emitLegacyPromiseCombinator,
  emitStandalonePromiseCombinatorRuntime as emitLegacyPromiseCombinatorRuntime,
  type NativeCombinator,
} from "./promise-combinators.js";
import {
  buildPromiseSettleClosureInstrs,
  ensureAsyncDriveRuntime,
  ensurePromiseExecutorClosures,
  PROMISE_STATE_PENDING,
  type PromiseExecutorClosures,
} from "./async-scheduler.js";

const EXTERNREF: ValType = { kind: "externref" };
type AsyncDriveRuntimeT = ReturnType<typeof ensureAsyncDriveRuntime>;
export type CombinatorRuntime = ReturnType<typeof ensureCombinatorFunctions>;

/** Only the all/race callers admitted by this protocol need these reactions. */
export function observableCombinatorReactionFns(
  ids: CombinatorRuntime,
  method: "all" | "race",
): { fulfillIdx: number; rejectIdx: number } {
  return {
    fulfillIdx: method === "all" ? ids.allFulfillFuncIdx : ids.raceFulfillFuncIdx,
    rejectIdx: ids.rejectFuncIdx,
  };
}

/**
 * (#5197 R3-2) The closure carrier for `Promise.all`'s per-element resolve
 * function.  The normal combinator runtime uses raw microtask callbacks, but
 * the observable protocol must hand a real, one-argument function object to
 * `nextPromise.then`.  Keep this tiny bridge separate from the legacy
 * subscribe/runtime bodies so sources that do not observe `resolve`/`then`
 * remain byte-identical.
 */
export interface ObservableCombinatorRuntime {
  /** `$__combinator_all_resolve_cap` subtype containing element caps + called bit. */
  allResolveCapTypeIdx: number;
  /** First capture after the inherited builtin-function metadata fields. */
  allResolveElemCapsFieldIdx: number;
  /** Mutable once-only bit used by §27.2.4.1 resolve-element functions. */
  allResolveCalledFieldIdx: number;
  /** Builtin metadata carrier used to make the closure observable as a function. */
  allResolveMetaTypeIdx: number;
  /** Target-standard exception tag used around observable Get/Call/Invoke. */
  exnTagIdx: number;
  /** Standard one-argument result capability resolve/reject closures. */
  settleClosures: PromiseExecutorClosures;
}

// Do not cache defined-function indices here. A later host import can shift
// them after this runtime has been registered; every observable emit site
// re-resolves its helper from `ctx.funcMap`, while these type indices remain
// stable for the lifetime of the module.

type CtxWithObservableCombinators = CodegenContext & {
  __promiseObservableCombinators?: ObservableCombinatorRuntime | null;
};

/** State shared by the literal and direct-vector observable paths. */
export interface ObservableCombinatorPreparation {
  resultLocal: number;
  ctorLocal: number;
  resolveLocal: number;
  abortedLocal: number;
  /** One result-capability resolve closure, shared by every observable race element. */
  raceFulfillLocal: number;
  /** One result-capability reject closure, shared by every observable element. */
  rejectLocal: number;
}

/**
 * Register the bounded R3-2 plumbing before an emitter splices any detached
 * argument buffers into a function body.  Every existing native combinator
 * helper deliberately remains untouched: the source-wide observable gate is
 * the sole admission point for this additional machinery.
 */
export function ensureObservableCombinatorRuntime(
  ctx: CodegenContext,
  ids: CombinatorRuntime,
): ObservableCombinatorRuntime | null {
  const cache = ctx as CtxWithObservableCombinators;
  if (cache.__promiseObservableCombinators !== undefined) return cache.__promiseObservableCombinators;

  // Register the property-read/call substrate before minting our capture type.
  // `Promise.resolve` must be a reified closure in the unmodified case too: the
  // observable route always performs the actual Get/Call rather than assuming
  // the direct native entry point.
  ensureObjectRuntime(ctx);
  ensureObjVecBuilders(ctx);
  // A source that assigns/defines an own Promise `then` has already reserved
  // its carrier substrate. Make the shared presence predicate available before
  // observable native-own Invoke arms are emitted.
  reserveCarrierBagVisibility(ctx);
  const applyClosureIdx = reserveApplyClosure(ctx);
  ensureStandaloneBuiltinStaticMethodClosure(ctx, "Promise", "resolve");
  const executorClosures = ensurePromiseExecutorClosures(ctx);
  emitWasiErrorConstructor(ctx, "TypeError", 1);
  addStringConstantGlobal(ctx, "Promise resolve is not callable");
  addStringConstantGlobal(ctx, "Promise then is not callable");

  const externGetIdx = ctx.funcMap.get("__extern_get");
  const newTypeErrorIdx = ctx.funcMap.get("__new_TypeError");
  if (
    executorClosures === null ||
    externGetIdx === undefined ||
    applyClosureIdx === undefined ||
    newTypeErrorIdx === undefined
  ) {
    cache.__promiseObservableCombinators = null;
    return null;
  }

  const wrapper = getOrCreateFuncRefWrapperTypes(ctx, [EXTERNREF], []);
  if (!wrapper) {
    cache.__promiseObservableCombinators = null;
    return null;
  }
  const allResolveMetaTypeIdx = ensureBuiltinFnMetaType(
    ctx,
    wrapper.structTypeIdx,
    wrapper.closureInfo,
    "promise:all-resolve-element",
    "",
    1,
  );
  const metaFields = (ctx.mod.types[allResolveMetaTypeIdx] as { fields: FieldDef[] }).fields;
  const allResolveElemCapsFieldIdx = metaFields.length;
  const allResolveCalledFieldIdx = allResolveElemCapsFieldIdx + 1;
  const allResolveCapTypeIdx = ctx.mod.types.length;
  const allResolveFields: FieldDef[] = [
    ...metaFields.map((field) => ({ ...field })),
    { name: "$elemCaps", type: { kind: "ref", typeIdx: ids.elemCapsTypeIdx }, mutable: false },
    { name: "$called", type: { kind: "i32" }, mutable: true },
  ];
  ctx.mod.types.push({
    kind: "struct",
    name: "$__combinator_all_resolve_cap",
    fields: allResolveFields,
    superTypeIdx: allResolveMetaTypeIdx,
  });
  ctx.structMap.set("$__combinator_all_resolve_cap", allResolveCapTypeIdx);
  ctx.typeIdxToStructName.set(allResolveCapTypeIdx, "$__combinator_all_resolve_cap");
  ctx.structFields.set(
    "$__combinator_all_resolve_cap",
    allResolveFields.map((field) => ({ ...field })),
  );

  const allResolveFuncIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, allResolveFuncIdx, {
    name: "__combinator_all_resolve_element",
    typeIdx: wrapper.liftedFuncTypeIdx,
    locals: [{ name: "$cap", type: { kind: "ref", typeIdx: allResolveCapTypeIdx } }],
    body: [
      { op: "local.get", index: 0 },
      { op: "ref.cast", typeIdx: allResolveCapTypeIdx },
      { op: "local.set", index: 2 },
      { op: "local.get", index: 2 },
      { op: "struct.get", typeIdx: allResolveCapTypeIdx, fieldIdx: allResolveCalledFieldIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [],
        else: [
          { op: "local.get", index: 2 },
          { op: "i32.const", value: 1 },
          { op: "struct.set", typeIdx: allResolveCapTypeIdx, fieldIdx: allResolveCalledFieldIdx },
          { op: "local.get", index: 2 },
          { op: "struct.get", typeIdx: allResolveCapTypeIdx, fieldIdx: allResolveElemCapsFieldIdx },
          { op: "extern.convert_any" },
          { op: "local.get", index: 1 },
          { op: "call", funcIdx: ids.allFulfillFuncIdx },
          { op: "drop" },
        ],
      },
    ],
    exported: false,
  });
  ctx.funcMap.set("__combinator_all_resolve_element", allResolveFuncIdx);

  const result: ObservableCombinatorRuntime = {
    allResolveCapTypeIdx,
    allResolveElemCapsFieldIdx,
    allResolveCalledFieldIdx,
    allResolveMetaTypeIdx,
    exnTagIdx: ensureExnTag(ctx),
    settleClosures: executorClosures,
  };
  cache.__promiseObservableCombinators = result;
  return result;
}

// ── (#5197 R3-2) Observable Promise.all / Promise.race pipeline ───────────

/** Build `RejectPromise(result, reason)` plus the local abrupt-completion bit. */
function buildObservableRejectInstrs(
  rt: AsyncDriveRuntimeT,
  preparation: ObservableCombinatorPreparation,
  reasonInstrs: readonly Instr[],
): Instr[] {
  return [
    { op: "local.get", index: preparation.resultLocal },
    ...reasonInstrs,
    { op: "call", funcIdx: rt.rejectFuncIdx },
    { op: "drop" },
    { op: "i32.const", value: 1 },
    { op: "local.set", index: preparation.abortedLocal },
  ];
}

/** The observable path's `IsCallable` predicate over the shared closure set. */
function buildObservableCallableCheckInstrs(
  ctx: CodegenContext,
  valueLocal: number,
  callableLocal: number,
  anyLocal: number,
): Instr[] {
  return [
    { op: "i32.const", value: 0 },
    { op: "local.set", index: callableLocal },
    { op: "local.get", index: valueLocal },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [],
      else: [
        { op: "local.get", index: valueLocal },
        { op: "any.convert_extern" },
        { op: "local.set", index: anyLocal },
        ...buildClosureRefTestArms(ctx, anyLocal, [
          { op: "i32.const", value: 1 },
          { op: "local.set", index: callableLocal },
        ]),
      ],
    },
  ];
}

/** Emit a native TypeError rejection for a non-callable observable method. */
function buildObservableTypeErrorRejectInstrs(
  ctx: CodegenContext,
  rt: AsyncDriveRuntimeT,
  preparation: ObservableCombinatorPreparation,
  observable: ObservableCombinatorRuntime,
  message: string,
): Instr[] {
  return buildObservableRejectInstrs(rt, preparation, [
    ...stringConstantExternrefInstrs(ctx, message),
    { op: "call", funcIdx: ctx.funcMap.get("__new_TypeError")! },
  ]);
}

/**
 * Set up NewPromiseCapability's native result carrier and the one observable
 * `Get(C, "resolve")`.  The get is wrapped in the target-standard EH builder;
 * an abrupt completion rejects the already-created result and prevents any
 * later iterator/pipeline work.  The resolve value is intentionally held in a
 * local so later source writes cannot replace the captured method.
 */
export function emitObservableCombinatorPreparation(
  ctx: CodegenContext,
  fctx: FunctionContext,
  ids: CombinatorRuntime,
  rt: AsyncDriveRuntimeT,
  observable: ObservableCombinatorRuntime,
  method: "all" | "race",
): ObservableCombinatorPreparation {
  const resultLocal = allocLocal(fctx, `__comb_observable_result_${fctx.locals.length}`, {
    kind: "ref",
    typeIdx: ids.promiseTypeIdx,
  });
  const ctorLocal = allocLocal(fctx, `__comb_observable_ctor_${fctx.locals.length}`, EXTERNREF);
  const resolveLocal = allocLocal(fctx, `__comb_observable_resolve_${fctx.locals.length}`, EXTERNREF);
  const abortedLocal = allocLocal(fctx, `__comb_observable_abrupt_${fctx.locals.length}`, { kind: "i32" });
  const reasonLocal = allocLocal(fctx, `__comb_observable_reason_${fctx.locals.length}`, EXTERNREF);
  const callableLocal = allocLocal(fctx, `__comb_observable_callable_${fctx.locals.length}`, { kind: "i32" });
  const callableAnyLocal = allocLocal(fctx, `__comb_observable_callable_any_${fctx.locals.length}`, {
    kind: "anyref",
  });
  // §27.2.4.3.1 creates the aggregate capability's resolve/reject exactly
  // once, then passes those same function *objects* to each `then` Invoke.
  // Keep them in externref locals so a thenable can observe handler identity.
  const raceFulfillLocal =
    method === "race" ? allocLocal(fctx, `__comb_observable_race_fulfill_${fctx.locals.length}`, EXTERNREF) : -1;
  const rejectLocal = allocLocal(fctx, `__comb_observable_reject_${fctx.locals.length}`, EXTERNREF);
  const preparation = { resultLocal, ctorLocal, resolveLocal, abortedLocal, raceFulfillLocal, rejectLocal };

  // New native result promise: `Promise.all` / `race`'s capability promise.
  fctx.body.push(
    { op: "i32.const", value: PROMISE_STATE_PENDING },
    { op: "ref.null.extern" },
    { op: "ref.null.extern" },
    closureBagInitInstr(),
    { op: "struct.new", typeIdx: ids.promiseTypeIdx },
    { op: "local.set", index: resultLocal },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: abortedLocal },
  );

  if (method === "race") {
    fctx.body.push(
      ...buildPromiseSettleClosureInstrs(observable.settleClosures, ctx.funcMap.get("__promise_resolve_cl")!, [
        { op: "local.get", index: resultLocal },
      ]),
      { op: "extern.convert_any" },
      { op: "local.set", index: raceFulfillLocal },
    );
  }
  fctx.body.push(
    ...buildPromiseSettleClosureInstrs(observable.settleClosures, ctx.funcMap.get("__promise_reject_cl")!, [
      { op: "local.get", index: resultLocal },
    ]),
    { op: "extern.convert_any" },
    { op: "local.set", index: rejectLocal },
  );

  // `Promise` is the same identity-stable carrier the source-level mutation
  // writes target.  Do this before iterator draining so a throwing getter wins
  // over an observable iterator getter, as required by GetPromiseResolve.
  emitBuiltinConstructorIdentity(ctx, fctx, "Promise");
  fctx.body.push({ op: "local.set", index: ctorLocal });
  fctx.body.push(
    buildTargetTaggedTry(
      ctx,
      { kind: "empty" },
      [
        { op: "local.get", index: ctorLocal },
        ...stringConstantExternrefInstrs(ctx, "resolve"),
        { op: "call", funcIdx: ctx.funcMap.get("__extern_get")! },
        { op: "local.set", index: resolveLocal },
      ],
      [
        {
          tagIdx: observable.exnTagIdx,
          body: [
            { op: "local.set", index: reasonLocal },
            ...buildObservableRejectInstrs(rt, preparation, [{ op: "local.get", index: reasonLocal }]),
          ],
        },
      ],
    ),
  );

  // IsCallable(promiseResolve). A non-callable resolve is an abrupt completion
  // converted to a rejected capability, never a synchronous throw from the
  // direct-call lowering.
  fctx.body.push(
    { op: "local.get", index: abortedLocal },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...buildObservableCallableCheckInstrs(ctx, resolveLocal, callableLocal, callableAnyLocal),
        { op: "local.get", index: callableLocal },
        { op: "i32.eqz" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: buildObservableTypeErrorRejectInstrs(
            ctx,
            rt,
            preparation,
            observable,
            "Promise resolve is not callable",
          ),
        },
      ],
    },
  );
  return preparation;
}

/** Allocate the aggregate state once its (already-evaluated) input count is known. */
function emitObservableCombinatorState(
  fctx: FunctionContext,
  ids: CombinatorRuntime,
  preparation: ObservableCombinatorPreparation,
  method: "all" | "race",
  lengthInstrs: readonly Instr[],
): { stateLocal: number; arrLocal: number; lengthLocal: number } {
  const arrLocal = allocLocal(fctx, `__comb_observable_arr_${fctx.locals.length}`, {
    kind: "ref",
    typeIdx: ids.arrTypeIdx,
  });
  const stateLocal = allocLocal(fctx, `__comb_observable_state_${fctx.locals.length}`, {
    kind: "ref",
    typeIdx: ids.stateTypeIdx,
  });
  const lengthLocal = allocLocal(fctx, `__comb_observable_length_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push(
    ...lengthInstrs,
    { op: "local.set", index: lengthLocal },
    { op: "local.get", index: lengthLocal },
    { op: "array.new_default", typeIdx: ids.arrTypeIdx },
    { op: "local.set", index: arrLocal },
    { op: "local.get", index: preparation.resultLocal },
    { op: "local.get", index: arrLocal },
    { op: "local.get", index: lengthLocal },
    // Promise.all's remaining-elements count begins with its completion
    // sentinel. Each successfully-resolved element increments it immediately
    // before Invoke(next, "then", ...); iteration drops this final unit only
    // after every Invoke has returned. This prevents an eager thenable from
    // fulfilling the aggregate before a later abrupt Invoke can reject it.
    ...(method === "all"
      ? ([{ op: "i32.const", value: 1 }] satisfies Instr[])
      : ([{ op: "local.get", index: lengthLocal }] satisfies Instr[])),
    { op: "struct.new", typeIdx: ids.stateTypeIdx },
    { op: "local.set", index: stateLocal },
  );
  return { stateLocal, arrLocal, lengthLocal };
}

/**
 * Drop Promise.all's remaining-elements completion sentinel after its admitted
 * literal/direct-VEC iteration finishes. The final decrement is intentionally
 * absent when an earlier Get/Call/Invoke rejected the aggregate.
 */
function emitObservableAllIterationComplete(
  fctx: FunctionContext,
  ids: CombinatorRuntime,
  rt: AsyncDriveRuntimeT,
  method: NativeCombinator,
  preparation: ObservableCombinatorPreparation,
  state: { stateLocal: number; arrLocal: number; lengthLocal: number },
): void {
  if (method !== "all") return;
  const remainingLocal = allocLocal(fctx, `__comb_observable_remaining_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push(
    { op: "local.get", index: preparation.abortedLocal },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: state.stateLocal },
        { op: "local.get", index: state.stateLocal },
        { op: "struct.get", typeIdx: ids.stateTypeIdx, fieldIdx: 3 },
        { op: "i32.const", value: 1 },
        { op: "i32.sub" },
        { op: "local.tee", index: remainingLocal },
        { op: "struct.set", typeIdx: ids.stateTypeIdx, fieldIdx: 3 },
        { op: "local.get", index: remainingLocal },
        { op: "i32.eqz" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: preparation.resultLocal },
            { op: "local.get", index: state.lengthLocal },
            { op: "local.get", index: state.arrLocal },
            { op: "struct.new", typeIdx: ids.vecTypeIdx },
            { op: "extern.convert_any" },
            { op: "call", funcIdx: rt.fulfillFuncIdx },
            { op: "drop" },
          ],
        },
      ],
    },
  );
}

/** Mint the `resolveElement` closure passed to one observable `Promise.all` then call. */
function buildObservableAllResolveClosureInstrs(
  ctx: CodegenContext,
  observable: ObservableCombinatorRuntime,
  elemCapsLocal: number,
): Instr[] {
  return [
    { op: "ref.func", funcIdx: ctx.funcMap.get("__combinator_all_resolve_element")! },
    { op: "i32.const", value: 1 },
    closureBagInitInstr(),
    { op: "i32.const", value: 0 },
    { op: "i32.const", value: observable.allResolveMetaTypeIdx },
    { op: "local.get", index: elemCapsLocal },
    { op: "i32.const", value: 0 },
    { op: "struct.new", typeIdx: observable.allResolveCapTypeIdx },
    { op: "extern.convert_any" },
  ];
}

/**
 * (#6651 D2b) The aggregate-state types an observable element pipeline writes.
 * The literal/direct-VEC callers pass none and get `$CombinatorState`; the
 * driven dynamic-iterable `Promise.all` (`promise-combinator-drive.ts`) passes
 * its growable `$CombinatorDriveState` twin, which has the same field order.
 */
export interface ObservableElementCarrier {
  stateTypeIdx: number;
  elemCapsTypeIdx: number;
  subscribeFuncIdx: number;
  buildAllResolveClosure: (elemCapsLocal: number) => Instr[];
}

/**
 * Append one `Call(resolve, C, [value])` then `Invoke(next, "then", …)`
 * pipeline.  This is intentionally emitted at the call site: the captured
 * resolve method and constructor are per-combinator invocation, while the
 * legacy `__combinator_subscribe` helper is source-agnostic.
 */
export function emitObservableCombinatorElement(
  ctx: CodegenContext,
  fctx: FunctionContext,
  ids: CombinatorRuntime,
  rt: AsyncDriveRuntimeT,
  observable: ObservableCombinatorRuntime,
  preparation: ObservableCombinatorPreparation,
  method: "all" | "race",
  reaction: { fulfillIdx: number; rejectIdx: number },
  stateLocal: number,
  indexInstrs: readonly Instr[],
  inputInstrs: readonly Instr[],
  carrier: ObservableElementCarrier = {
    stateTypeIdx: ids.stateTypeIdx,
    elemCapsTypeIdx: ids.elemCapsTypeIdx,
    subscribeFuncIdx: ids.subscribeFuncIdx,
    buildAllResolveClosure: (elemCapsLocal) => buildObservableAllResolveClosureInstrs(ctx, observable, elemCapsLocal),
  },
): void {
  const inputLocal = allocLocal(fctx, `__comb_observable_input_${fctx.locals.length}`, EXTERNREF);
  const resolveArgsLocal = allocLocal(fctx, `__comb_observable_resolve_args_${fctx.locals.length}`, EXTERNREF);
  const thenArgsLocal = allocLocal(fctx, `__comb_observable_then_args_${fctx.locals.length}`, EXTERNREF);
  const nextLocal = allocLocal(fctx, `__comb_observable_next_${fctx.locals.length}`, EXTERNREF);
  const errorLocal = allocLocal(fctx, `__comb_observable_error_${fctx.locals.length}`, EXTERNREF);
  const thenLocal = allocLocal(fctx, `__comb_observable_then_${fctx.locals.length}`, EXTERNREF);
  const callableLocal = allocLocal(fctx, `__comb_observable_then_callable_${fctx.locals.length}`, { kind: "i32" });
  const callableAnyLocal = allocLocal(fctx, `__comb_observable_then_any_${fctx.locals.length}`, { kind: "anyref" });
  const nextAnyLocal = allocLocal(fctx, `__comb_observable_next_any_${fctx.locals.length}`, { kind: "anyref" });
  const elemCapsLocal =
    method === "all"
      ? allocLocal(fctx, `__comb_observable_elem_caps_${fctx.locals.length}`, {
          kind: "ref",
          typeIdx: carrier.elemCapsTypeIdx,
        })
      : -1;

  // Literal callers pass a pre-evaluated local; direct-vector callers pass the
  // current slot. No source argument expression is evaluated here, so an
  // earlier abrupt pipeline element cannot change argument-list evaluation.
  fctx.body.push(...inputInstrs, { op: "local.set", index: inputLocal });

  const buildRejectFromError = (): Instr[] => [
    { op: "local.set", index: errorLocal },
    ...buildObservableRejectInstrs(rt, preparation, [{ op: "local.get", index: errorLocal }]),
  ];
  const buildFulfilHandler = (): Instr[] => {
    if (method === "all") {
      return [
        { op: "local.get", index: stateLocal },
        ...indexInstrs,
        { op: "struct.new", typeIdx: carrier.elemCapsTypeIdx },
        { op: "local.set", index: elemCapsLocal },
        ...carrier.buildAllResolveClosure(elemCapsLocal),
      ];
    }
    return [{ op: "local.get", index: preparation.raceFulfillLocal }];
  };
  const buildRejectHandler = (): Instr[] => [{ op: "local.get", index: preparation.rejectLocal }];
  const buildThenArgs = (): Instr[] => [
    { op: "call", funcIdx: ctx.funcMap.get("__objvec_new")! },
    { op: "local.set", index: thenArgsLocal },
    { op: "local.get", index: thenArgsLocal },
    ...buildFulfilHandler(),
    { op: "call", funcIdx: ctx.funcMap.get("__objvec_push")! },
    { op: "local.get", index: thenArgsLocal },
    ...buildRejectHandler(),
    { op: "call", funcIdx: ctx.funcMap.get("__objvec_push")! },
  ];
  const buildLegacySubscribe = (): Instr[] => [
    { op: "local.get", index: nextLocal },
    { op: "local.get", index: stateLocal },
    { op: "extern.convert_any" },
    ...indexInstrs,
    { op: "ref.func", funcIdx: reaction.fulfillIdx },
    { op: "ref.func", funcIdx: reaction.rejectIdx },
    { op: "call", funcIdx: carrier.subscribeFuncIdx },
  ];
  const buildNativeInvoke = (): Instr[] => {
    const carrierBagHasIdx = ctx.funcMap.get("__carrier_bag_has");
    if (carrierBagHasIdx === undefined) return buildLegacySubscribe();
    return [
      { op: "local.get", index: nextLocal },
      ...stringConstantExternrefInstrs(ctx, "then"),
      { op: "call", funcIdx: carrierBagHasIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          buildTargetTaggedTry(
            ctx,
            { kind: "empty" },
            [
              { op: "local.get", index: nextLocal },
              ...stringConstantExternrefInstrs(ctx, "then"),
              { op: "call", funcIdx: ctx.funcMap.get("__extern_get")! },
              { op: "local.set", index: thenLocal },
              ...buildObservableCallableCheckInstrs(ctx, thenLocal, callableLocal, callableAnyLocal),
              { op: "local.get", index: callableLocal },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  { op: "local.get", index: thenLocal },
                  { op: "local.get", index: nextLocal },
                  { op: "local.get", index: thenArgsLocal },
                  { op: "call", funcIdx: ctx.funcMap.get("__apply_closure")! },
                  { op: "drop" },
                ],
                else: buildObservableTypeErrorRejectInstrs(
                  ctx,
                  rt,
                  preparation,
                  observable,
                  "Promise then is not callable",
                ),
              },
            ],
            [{ tagIdx: observable.exnTagIdx, body: buildRejectFromError() }],
          ),
        ],
        else: buildLegacySubscribe(),
      },
    ];
  };
  // `Invoke(nextPromise, "then", handlers)` performs ONE Get, then calls the
  // captured value.  Do not route through `__promise_has_callable_then` plus
  // `__call_m_then_vararg`: that pair gets an accessor once to classify it and
  // again to dispatch it, which is observably wrong when the getter changes its
  // answer. `__extern_get` is the runtime's ordinary property read for open
  // objects, closure bags, and finalized closed-struct field ladders.
  const buildNonNativeInvoke = (): Instr[] => [
    buildTargetTaggedTry(
      ctx,
      { kind: "empty" },
      [
        { op: "local.get", index: nextLocal },
        ...stringConstantExternrefInstrs(ctx, "then"),
        { op: "call", funcIdx: ctx.funcMap.get("__extern_get")! },
        { op: "local.set", index: thenLocal },
        ...buildObservableCallableCheckInstrs(ctx, thenLocal, callableLocal, callableAnyLocal),
        { op: "local.get", index: callableLocal },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: thenLocal },
            { op: "local.get", index: nextLocal },
            { op: "local.get", index: thenArgsLocal },
            { op: "call", funcIdx: ctx.funcMap.get("__apply_closure")! },
            { op: "drop" },
          ],
          else: buildObservableTypeErrorRejectInstrs(ctx, rt, preparation, observable, "Promise then is not callable"),
        },
      ],
      [{ tagIdx: observable.exnTagIdx, body: buildRejectFromError() }],
    ),
  ];
  // §27.2.4.1's remainingElementsCount gains one for this element only after
  // Call(resolve, C, value) succeeds, and before a synchronously-calling
  // thenable can invoke the resolve-element closure. The final completion
  // sentinel remains until the enclosing literal/VEC iteration has finished.
  const buildAllRemainingIncrement = (): Instr[] =>
    method === "all"
      ? [
          { op: "local.get", index: stateLocal },
          { op: "local.get", index: stateLocal },
          { op: "struct.get", typeIdx: carrier.stateTypeIdx, fieldIdx: 3 },
          { op: "i32.const", value: 1 },
          { op: "i32.add" },
          { op: "struct.set", typeIdx: carrier.stateTypeIdx, fieldIdx: 3 },
        ]
      : [];

  const pipeline: Instr[] = [
    // Call(promiseResolve, C, «nextValue»).
    buildTargetTaggedTry(
      ctx,
      { kind: "empty" },
      [
        { op: "call", funcIdx: ctx.funcMap.get("__objvec_new")! },
        { op: "local.set", index: resolveArgsLocal },
        { op: "local.get", index: resolveArgsLocal },
        { op: "local.get", index: inputLocal },
        { op: "call", funcIdx: ctx.funcMap.get("__objvec_push")! },
        ...buildThenArgs(),
        { op: "local.get", index: preparation.resolveLocal },
        { op: "local.get", index: preparation.ctorLocal },
        { op: "local.get", index: resolveArgsLocal },
        { op: "call", funcIdx: ctx.funcMap.get("__apply_closure")! },
        { op: "local.set", index: nextLocal },
      ],
      [{ tagIdx: observable.exnTagIdx, body: buildRejectFromError() }],
    ),
    // Invoke(nextPromise, "then", «fulfill, reject»). A `$Promise` without an
    // own `then` keeps the tested legacy subscription path; an own slot is
    // retrieved and called with the native promise as receiver. Other values
    // use the same one-Get/captured-call Invoke sequence.
    { op: "local.get", index: preparation.abortedLocal },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...buildAllRemainingIncrement(),
        { op: "local.get", index: nextLocal },
        { op: "ref.is_null" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: buildNonNativeInvoke(),
          else: [
            { op: "local.get", index: nextLocal },
            { op: "any.convert_extern" },
            { op: "local.set", index: nextAnyLocal },
            { op: "local.get", index: nextAnyLocal },
            { op: "ref.test", typeIdx: ids.promiseTypeIdx },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: buildNativeInvoke(),
              else: buildNonNativeInvoke(),
            },
          ],
        },
      ],
    },
  ];

  fctx.body.push(
    { op: "local.get", index: preparation.abortedLocal },
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: pipeline },
  );
}

/**
 * Bounded R3-2 literal route. It shares the old result/reaction substrate but
 * replaces only the per-element normalization shortcut with the observable
 * Get/Call/Invoke protocol. `allSettled`/`any`, custom constructors, and
 * iterator-closing stay on their existing/future slices.
 */
function emitObservableStandalonePromiseCombinatorLiteral(
  ctx: CodegenContext,
  fctx: FunctionContext,
  method: "all" | "race",
  elementInstrs: Instr[][],
  ids: CombinatorRuntime,
  rt: AsyncDriveRuntimeT,
  observable: ObservableCombinatorRuntime,
): ValType {
  const reaction = observableCombinatorReactionFns(ids, method);
  // Argument-list evaluation finishes BEFORE the static call begins. The
  // buffers above are compile-time staging only; execute every element now and
  // retain its value before `Get(Promise, "resolve")`. In particular,
  // `Promise.all([first(), second()])` must run both calls even when resolve's
  // getter subsequently throws.
  const inputLocals: number[] = [];
  for (const element of elementInstrs) {
    const inputLocal = allocLocal(fctx, `__comb_observable_literal_input_${fctx.locals.length}`, EXTERNREF);
    fctx.body.push(...element, { op: "local.set", index: inputLocal });
    inputLocals.push(inputLocal);
  }
  const preparation = emitObservableCombinatorPreparation(ctx, fctx, ids, rt, observable, method);
  const state = emitObservableCombinatorState(fctx, ids, preparation, method, [
    { op: "i32.const", value: elementInstrs.length },
  ]);
  for (let i = 0; i < inputLocals.length; i++) {
    emitObservableCombinatorElement(
      ctx,
      fctx,
      ids,
      rt,
      observable,
      preparation,
      method,
      reaction,
      state.stateLocal,
      [{ op: "i32.const", value: i }],
      [{ op: "local.get", index: inputLocals[i]! }],
    );
  }
  emitObservableAllIterationComplete(fctx, ids, rt, method, preparation, state);
  fctx.body.push({ op: "local.get", index: preparation.resultLocal }, { op: "extern.convert_any" });
  return EXTERNREF;
}

/**
 * Bounded R3-2 admission for a native `number[]` carrier. Unlike the legacy
 * generic path, the observable loop reads and boxes each f64 slot only when
 * its turn reaches `Call(resolve, C, value)`, leaving earlier resolve calls
 * able to mutate a later vector element before it is observed.
 */
export function resolveF64VecArg(
  ctx: CodegenContext,
  argType: ValType | null,
): { vecTypeIdx: number; arrTypeIdx: number } | null {
  if (!argType || (argType.kind !== "ref" && argType.kind !== "ref_null")) return null;
  const vecTypeIdx = (argType as { typeIdx?: number }).typeIdx;
  if (typeof vecTypeIdx !== "number" || vecTypeIdx < 0) return null;
  const structName = ctx.typeIdxToStructName.get(vecTypeIdx);
  if (!structName || !structName.startsWith("__vec_")) return null;
  const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
  if (arrTypeIdx < 0) return null;
  const arrDef = ctx.mod.types[arrTypeIdx];
  if (!arrDef || arrDef.kind !== "array" || arrDef.element.kind !== "f64") return null;
  return { vecTypeIdx, arrTypeIdx };
}

/** Observable R3-2 analogue of the pre-existing externref-vector loop. */
function emitObservableStandalonePromiseCombinatorRuntime(
  ctx: CodegenContext,
  fctx: FunctionContext,
  method: "all" | "race",
  argVecLocal: number,
  argVecTypeIdx: number,
  argArrTypeIdx: number,
  ids: CombinatorRuntime,
  rt: AsyncDriveRuntimeT,
  observable: ObservableCombinatorRuntime,
  boxF64Elements: boolean,
): ValType {
  const reaction = observableCombinatorReactionFns(ids, method);
  const preparation = emitObservableCombinatorPreparation(ctx, fctx, ids, rt, observable, method);
  const boxNumberIdx = boxF64Elements ? ctx.funcMap.get("__box_number") : undefined;
  if (boxF64Elements && boxNumberIdx === undefined) {
    throw new Error("observable f64 Promise combinator requires __box_number");
  }
  const state = emitObservableCombinatorState(fctx, ids, preparation, method, [
    { op: "local.get", index: argVecLocal },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: argVecTypeIdx, fieldIdx: 0 },
  ]);
  const iLocal = allocLocal(fctx, `__comb_observable_i_${fctx.locals.length}`, { kind: "i32" });

  fctx.body.push(
    { op: "i32.const", value: 0 },
    { op: "local.set", index: iLocal },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: iLocal },
            { op: "local.get", index: state.lengthLocal },
            { op: "i32.ge_s" },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: preparation.abortedLocal },
            { op: "br_if", depth: 1 },
            // `emitObservableCombinatorElement` needs to append nested
            // instructions to the loop, so its body is patched below rather
            // than built as an opaque detached array.
          ],
        },
      ],
    },
  );

  // Replace the just-emitted loop body with the element pipeline while it is
  // still live in fctx.body. This avoids a second runtime implementation and
  // keeps every late-index shifter able to walk the nested instructions.
  const outerBlock = fctx.body[fctx.body.length - 1] as Extract<Instr, { op: "block" }>;
  const loop = outerBlock.body[0] as Extract<Instr, { op: "loop" }>;
  const loopBody = loop.body;
  const savedBody = fctx.body;
  fctx.body = loopBody;
  fctx.savedBodies.push(savedBody);
  try {
    emitObservableCombinatorElement(
      ctx,
      fctx,
      ids,
      rt,
      observable,
      preparation,
      method,
      reaction,
      state.stateLocal,
      [{ op: "local.get", index: iLocal }],
      [
        { op: "local.get", index: argVecLocal },
        { op: "ref.as_non_null" },
        { op: "struct.get", typeIdx: argVecTypeIdx, fieldIdx: 1 },
        { op: "local.get", index: iLocal },
        { op: "array.get", typeIdx: argArrTypeIdx },
        ...(boxF64Elements ? ([{ op: "call", funcIdx: boxNumberIdx! }] satisfies Instr[]) : []),
      ],
    );
    loopBody.push(
      { op: "local.get", index: iLocal },
      { op: "i32.const", value: 1 },
      { op: "i32.add" },
      { op: "local.set", index: iLocal },
      { op: "br", depth: 0 },
    );
  } finally {
    fctx.savedBodies.pop();
    fctx.body = savedBody;
  }
  emitObservableAllIterationComplete(fctx, ids, rt, method, preparation, state);
  fctx.body.push({ op: "local.get", index: preparation.resultLocal }, { op: "extern.convert_any" });
  return EXTERNREF;
}

/** Preserve main's optional literal protocol and its legacy fallback. */
export function emitStandalonePromiseCombinator(
  ctx: CodegenContext,
  fctx: FunctionContext,
  method: NativeCombinator,
  elementInstrs: Instr[][],
  opts?: { observableResolve?: boolean },
): ValType {
  if (opts?.observableResolve === true && (method === "all" || method === "race")) {
    const ids = ensureCombinatorFunctions(ctx);
    ensureAsyncDriveRuntime(ctx);
    const observable = ensureObservableCombinatorRuntime(ctx, ids);
    if (observable) {
      return emitObservableStandalonePromiseCombinatorLiteral(
        ctx,
        fctx,
        method,
        elementInstrs,
        ids,
        ensureAsyncDriveRuntime(ctx),
        observable,
      );
    }
  }
  return emitLegacyPromiseCombinator(ctx, fctx, method, elementInstrs);
}

/** Preserve main's optional vector protocol and its legacy rejection-pair fallback. */
export function emitStandalonePromiseCombinatorRuntime(
  ctx: CodegenContext,
  fctx: FunctionContext,
  method: NativeCombinator,
  argVecLocal: number,
  argVecTypeIdx: number,
  argArrTypeIdx: number,
  opts?: {
    notIterLocal?: number;
    rejectReason?: Instr[];
    observableResolve?: boolean;
    /** R3-2 direct `number[]` arm: box each f64 slot at consumption time. */
    boxF64Elements?: boolean;
  },
): ValType {
  if (opts?.observableResolve === true && (method === "all" || method === "race")) {
    const ids = ensureCombinatorFunctions(ctx);
    ensureAsyncDriveRuntime(ctx);
    const observable = ensureObservableCombinatorRuntime(ctx, ids);
    if (observable) {
      return emitObservableStandalonePromiseCombinatorRuntime(
        ctx,
        fctx,
        method,
        argVecLocal,
        argVecTypeIdx,
        argArrTypeIdx,
        ids,
        ensureAsyncDriveRuntime(ctx),
        observable,
        opts.boxF64Elements === true,
      );
    }
  }
  return emitLegacyPromiseCombinatorRuntime(
    ctx,
    fctx,
    method,
    argVecLocal,
    argVecTypeIdx,
    argArrTypeIdx,
    opts?.notIterLocal !== undefined && opts.rejectReason !== undefined
      ? { notIterLocal: opts.notIterLocal, rejectReason: opts.rejectReason }
      : undefined,
  );
}
