// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#5197 R3-2) Observable intrinsic Promise.all/race routes.
//
// This deliberately sits beside, rather than inside, promise-combinators.ts.
// #5759 freezes that legacy adapter's source-preservation bridge; the static
// call dispatcher enters this module only after its observable source gate has
// admitted a direct literal or vector input.

import { buildTargetTaggedTry } from "../ir/try-table.js";
import type { FieldDef, Instr, ValType } from "../ir/types.js";
import {
  PROMISE_STATE_PENDING,
  type PromiseExecutorClosures,
  buildPromiseSettleClosureInstrs,
  ensureAsyncDriveRuntime,
  ensurePromiseExecutorClosures,
} from "./async-scheduler.js";
import { ensureBuiltinFnMetaType } from "./builtin-fn-meta.js";
import { emitBuiltinConstructorIdentity } from "./builtin-static-globals.js";
import { ensureStandaloneBuiltinStaticMethodClosure } from "./builtin-value-read.js";
import { reserveCarrierBagVisibility } from "./carrier-bag-visibility.js";
import { buildClosureRefTestArms } from "./closure-classifier.js";
import { closureBagInitInstr, getOrCreateFuncRefWrapperTypes } from "./closures/funcref-wrapper-types.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { ensureObjVecBuilders, ensureObjectRuntime, reserveApplyClosure } from "./object-runtime.js";
import { ensureCombinatorFunctions } from "./promise-combinators.js";
import { emitWasiErrorConstructor } from "./registry/error-types.js";
import { ensureExnTag } from "./registry/imports.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { getArrTypeIdxFromVec } from "./registry/types.js";

const EXTERNREF: ValType = { kind: "externref" };

type AsyncDriveRuntimeT = ReturnType<typeof ensureAsyncDriveRuntime>;
type CombinatorRuntime = ReturnType<typeof ensureCombinatorFunctions>;

/** `$__combinator_all_resolve_cap` resources registered once per module. */
interface ObservableCombinatorRuntime {
  allResolveCapTypeIdx: number;
  allResolveElemCapsFieldIdx: number;
  allResolveCalledFieldIdx: number;
  allResolveMetaTypeIdx: number;
  exnTagIdx: number;
  settleClosures: PromiseExecutorClosures;
}

type CtxWithObservableCombinators = CodegenContext & {
  __promiseObservableCombinators?: ObservableCombinatorRuntime;
};

interface ObservableCombinatorPreparation {
  resultLocal: number;
  ctorLocal: number;
  resolveLocal: number;
  abortedLocal: number;
  raceFulfillLocal: number;
  rejectLocal: number;
}

/** Register observable-only plumbing before any detached argument buffer is spliced. */
function ensureObservableCombinatorRuntime(ctx: CodegenContext, ids: CombinatorRuntime): ObservableCombinatorRuntime {
  const cache = ctx as CtxWithObservableCombinators;
  if (cache.__promiseObservableCombinators !== undefined) return cache.__promiseObservableCombinators;

  ensureObjectRuntime(ctx);
  ensureObjVecBuilders(ctx);
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
    throw new Error(
      "observable Promise combinator pipeline requires closure invocation, property reads, and TypeError runtime support",
    );
  }

  const wrapper = getOrCreateFuncRefWrapperTypes(ctx, [EXTERNREF], []);
  if (!wrapper) {
    throw new Error("observable Promise combinator pipeline requires a one-argument closure wrapper");
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
    {
      name: "$elemCaps",
      type: { kind: "ref", typeIdx: ids.elemCapsTypeIdx },
      mutable: false,
    },
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
      {
        op: "struct.get",
        typeIdx: allResolveCapTypeIdx,
        fieldIdx: allResolveCalledFieldIdx,
      },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [],
        else: [
          { op: "local.get", index: 2 },
          { op: "i32.const", value: 1 },
          {
            op: "struct.set",
            typeIdx: allResolveCapTypeIdx,
            fieldIdx: allResolveCalledFieldIdx,
          },
          { op: "local.get", index: 2 },
          {
            op: "struct.get",
            typeIdx: allResolveCapTypeIdx,
            fieldIdx: allResolveElemCapsFieldIdx,
          },
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

function observableReactionFns(
  ids: CombinatorRuntime,
  method: "all" | "race",
): { fulfillIdx: number; rejectIdx: number } {
  return {
    fulfillIdx: method === "all" ? ids.allFulfillFuncIdx : ids.raceFulfillFuncIdx,
    rejectIdx: ids.rejectFuncIdx,
  };
}

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
  message: string,
): Instr[] {
  return buildObservableRejectInstrs(rt, preparation, [
    ...stringConstantExternrefInstrs(ctx, message),
    { op: "call", funcIdx: ctx.funcMap.get("__new_TypeError")! },
  ]);
}

/**
 * Set up the result carrier and the sole observable `Get(Promise, "resolve")`.
 * The captured method remains in a local for every element in this invocation.
 */
function emitObservableCombinatorPreparation(
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
  const raceFulfillLocal =
    method === "race" ? allocLocal(fctx, `__comb_observable_race_fulfill_${fctx.locals.length}`, EXTERNREF) : -1;
  const rejectLocal = allocLocal(fctx, `__comb_observable_reject_${fctx.locals.length}`, EXTERNREF);
  const preparation = {
    resultLocal,
    ctorLocal,
    resolveLocal,
    abortedLocal,
    raceFulfillLocal,
    rejectLocal,
  };

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
          then: buildObservableTypeErrorRejectInstrs(ctx, rt, preparation, "Promise resolve is not callable"),
        },
      ],
    },
  );
  return preparation;
}

/** Allocate aggregate state after literal inputs have all been materialized. */
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
    ...(method === "all"
      ? ([{ op: "i32.const", value: 1 }] satisfies Instr[])
      : ([{ op: "local.get", index: lengthLocal }] satisfies Instr[])),
    { op: "struct.new", typeIdx: ids.stateTypeIdx },
    { op: "local.set", index: stateLocal },
  );
  return { stateLocal, arrLocal, lengthLocal };
}

/** Drop Promise.all's iteration-completion sentinel after every admitted element ran. */
function emitObservableAllIterationComplete(
  fctx: FunctionContext,
  ids: CombinatorRuntime,
  rt: AsyncDriveRuntimeT,
  method: "all" | "race",
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

function buildObservableAllResolveClosureInstrs(
  ctx: CodegenContext,
  observable: ObservableCombinatorRuntime,
  elemCapsLocal: number,
): Instr[] {
  return [
    {
      op: "ref.func",
      funcIdx: ctx.funcMap.get("__combinator_all_resolve_element")!,
    },
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

/** Append one `Call(resolve, C, value)` followed by the one-Get `then` Invoke. */
function emitObservableCombinatorElement(
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
          typeIdx: ids.elemCapsTypeIdx,
        })
      : -1;

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
        { op: "struct.new", typeIdx: ids.elemCapsTypeIdx },
        { op: "local.set", index: elemCapsLocal },
        ...buildObservableAllResolveClosureInstrs(ctx, observable, elemCapsLocal),
      ];
    }
    return [{ op: "local.get", index: preparation.raceFulfillLocal }];
  };
  const buildThenArgs = (): Instr[] => [
    { op: "call", funcIdx: ctx.funcMap.get("__objvec_new")! },
    { op: "local.set", index: thenArgsLocal },
    { op: "local.get", index: thenArgsLocal },
    ...buildFulfilHandler(),
    { op: "call", funcIdx: ctx.funcMap.get("__objvec_push")! },
    { op: "local.get", index: thenArgsLocal },
    { op: "local.get", index: preparation.rejectLocal },
    { op: "call", funcIdx: ctx.funcMap.get("__objvec_push")! },
  ];
  const buildLegacySubscribe = (): Instr[] => [
    { op: "local.get", index: nextLocal },
    { op: "local.get", index: stateLocal },
    { op: "extern.convert_any" },
    ...indexInstrs,
    { op: "ref.func", funcIdx: reaction.fulfillIdx },
    { op: "ref.func", funcIdx: reaction.rejectIdx },
    { op: "call", funcIdx: ids.subscribeFuncIdx },
  ];
  const buildCapturedInvoke = (): Instr[] => [
    { op: "local.get", index: thenLocal },
    { op: "local.get", index: nextLocal },
    { op: "local.get", index: thenArgsLocal },
    { op: "call", funcIdx: ctx.funcMap.get("__apply_closure")! },
    { op: "drop" },
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
                then: buildCapturedInvoke(),
                else: buildObservableTypeErrorRejectInstrs(ctx, rt, preparation, "Promise then is not callable"),
              },
            ],
            [{ tagIdx: observable.exnTagIdx, body: buildRejectFromError() }],
          ),
        ],
        else: buildLegacySubscribe(),
      },
    ];
  };
  // Ordinary values and native promises with an own `then` both use this
  // captured getter path. The no-own-native case retains the legacy fast path.
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
          then: buildCapturedInvoke(),
          else: buildObservableTypeErrorRejectInstrs(ctx, rt, preparation, "Promise then is not callable"),
        },
      ],
      [{ tagIdx: observable.exnTagIdx, body: buildRejectFromError() }],
    ),
  ];
  const buildAllRemainingIncrement = (): Instr[] =>
    method === "all"
      ? [
          { op: "local.get", index: stateLocal },
          { op: "local.get", index: stateLocal },
          { op: "struct.get", typeIdx: ids.stateTypeIdx, fieldIdx: 3 },
          { op: "i32.const", value: 1 },
          { op: "i32.add" },
          { op: "struct.set", typeIdx: ids.stateTypeIdx, fieldIdx: 3 },
        ]
      : [];

  const pipeline: Instr[] = [
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
 * Lower the admitted literal route. Input expressions execute completely before
 * `Get(Promise, "resolve")`; the retained locals are then consumed in order.
 */
export function emitObservableStandalonePromiseCombinatorLiteral(
  ctx: CodegenContext,
  fctx: FunctionContext,
  method: "all" | "race",
  elementInstrs: Instr[][],
): ValType {
  const ids = ensureCombinatorFunctions(ctx);
  const rt = ensureAsyncDriveRuntime(ctx);
  const observable = ensureObservableCombinatorRuntime(ctx, ids);

  const reaction = observableReactionFns(ids, method);
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

/** Check for a f64-backed direct vector admitted by the observable route. */
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

/** Lower an admitted direct vector without eager element copying. */
export function emitObservableStandalonePromiseCombinatorRuntime(
  ctx: CodegenContext,
  fctx: FunctionContext,
  method: "all" | "race",
  argVecLocal: number,
  argVecTypeIdx: number,
  argArrTypeIdx: number,
  opts?: { boxF64Elements?: boolean },
): ValType {
  const ids = ensureCombinatorFunctions(ctx);
  const rt = ensureAsyncDriveRuntime(ctx);
  const observable = ensureObservableCombinatorRuntime(ctx, ids);

  const reaction = observableReactionFns(ids, method);
  const preparation = emitObservableCombinatorPreparation(ctx, fctx, ids, rt, observable, method);
  const boxNumberIdx = opts?.boxF64Elements === true ? ctx.funcMap.get("__box_number") : undefined;
  if (opts?.boxF64Elements === true && boxNumberIdx === undefined) {
    throw new Error("observable f64 Promise combinator requires __box_number");
  }
  const state = emitObservableCombinatorState(fctx, ids, preparation, method, [
    { op: "local.get", index: argVecLocal },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: argVecTypeIdx, fieldIdx: 0 },
  ]);
  const iLocal = allocLocal(fctx, `__comb_observable_i_${fctx.locals.length}`, {
    kind: "i32",
  });

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
          ],
        },
      ],
    },
  );
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
        ...(opts?.boxF64Elements === true ? ([{ op: "call", funcIdx: boxNumberIdx! }] satisfies Instr[]) : []),
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
