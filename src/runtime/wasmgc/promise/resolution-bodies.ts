// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { FuncHandle, TypeHandle, Instr, LocalDef } from "../../../wasm/model/instructions.js";
import { buildTargetTaggedTry } from "../../../wasm/physical/exception-control.js";
import { PROMISE_STATE_FULFILLED, PROMISE_STATE_REJECTED } from "./settlement-bodies.js";

export interface PromiseResolutionBindings {
  readonly hasCallableThenFuncIdx: FuncHandle;
  readonly thenableJobFuncIdx: FuncHandle;
  readonly peelValueFuncIdx: FuncHandle;
  readonly newTypeErrorFuncIdx: FuncHandle;
}
export interface PromiseResolveValueResources {
  readonly target: { wasi: boolean; standalone: boolean };
  readonly state: {
    readonly promiseFulfillFuncIdx: FuncHandle;
    readonly promiseRejectFuncIdx: FuncHandle;
    readonly enqueueFuncIdx: FuncHandle;
    readonly identityFulfillWrapperFuncIdx: FuncHandle;
    readonly identityRejectWrapperFuncIdx: FuncHandle;
  };
  readonly promiseTypeIdx: TypeHandle;
  readonly callbackTypeIdx: TypeHandle;
  readonly capsTypeIdx: TypeHandle;
  readonly promiseFields: { readonly state: number; readonly value: number; readonly callbacks: number };
  readonly callbackFields: readonly [0, 1, 2, 3, 4];
  readonly capsFields: { readonly callback: 0; readonly chained: 1 };
  /** null is legacy compatibility only; a completed native pack requires bindings. */
  readonly thenable: PromiseResolutionBindings | null;
  readonly exnTagIdx: number;
  readonly selfResolutionStringInstrs: readonly Instr[];
  readonly thenStringInstrs: readonly Instr[];
  readonly thenGetStringInstrs: readonly Instr[];
  readonly bagHasIdx: FuncHandle | undefined;
  readonly externGetIdx: FuncHandle | undefined;
  readonly typeofFunctionIdx: FuncHandle | undefined;
  readonly callableRootTypeIdx: TypeHandle | undefined;
}

/** Completed native packs must use this entry point; null is not native resolution. */
export function buildNativePromiseResolveValueBody(
  resources: PromiseResolveValueResources & { readonly thenable: PromiseResolutionBindings },
): Instr[] {
  if (!resources.thenable || !resources.selfResolutionStringInstrs?.length)
    throw new Error("Native Promise resolution requires complete thenable and TypeError bindings");
  for (const handle of [
    resources.thenable.hasCallableThenFuncIdx,
    resources.thenable.thenableJobFuncIdx,
    resources.thenable.peelValueFuncIdx,
    resources.thenable.newTypeErrorFuncIdx,
  ])
    if (!Number.isInteger(handle) || handle < 0)
      throw new Error("Native Promise resolution has an invalid thenable binding");
  return buildPromiseResolveValueBody(resources);
}
export function buildPromiseResolveValueLocals(promiseTypeIdx: TypeHandle): LocalDef[] {
  // Params 0/1: (promise, value). Locals start at 2.
  return [
    { name: "$inner", type: { kind: "ref", typeIdx: promiseTypeIdx } },
    { name: "$caps", type: { kind: "externref" } },
    // (#3125) thenable-assimilation scratch: Get("then") callability verdict +
    // the caught poisoned-getter reason + the `$AnyValue`-peeled resolution.
    { name: "$hasThen", type: { kind: "i32" } },
    { name: "$reason", type: { kind: "externref" } },
    { name: "$poisoned", type: { kind: "i32" } },
    { name: "$peeled", type: { kind: "externref" } },
    // (#5197 R3-5) The own `then` read off a native `$Promise` resolution.
    { name: "$bagThen", type: { kind: "externref" } },
  ];
}

/**
 * (#2867 Gap 1) `__promise_resolve_value(promise, value)` — the spec
 * "Resolve(promise, value)" step for the native `$Promise` carrier.
 *
 * If `value` is a native `$Promise`, `promise` ADOPTS that inner promise's
 * eventual state instead of fulfilling with the promise object:
 *   - inner FULFILLED  → enqueue `__then_identity_fulfill(caps, inner.value)`
 *   - inner REJECTED   → enqueue `__then_identity_reject(caps, inner.value)`
 *   - inner PENDING    → prepend a `$PromiseCallback` reaction onto inner.callbacks
 * where `caps` is `$__then_caps{callback: null, chained: promise}`, so the
 * identity wrappers settle `promise` when the inner promise eventually settles.
 * Because `__then_identity_fulfill` itself routes back through this helper, a
 * chain of promises-returning-promises is assimilated recursively.
 *
 * If `value` is not a `$Promise`, it checks for a user THENABLE first (#3125,
 * §27.2.1.3.2 steps 6–14): a self-resolution rejects with a TypeError, an
 * object with a callable `then` enqueues a PromiseResolveThenableJob, a
 * poisoned `then` getter rejects with the thrown value, and everything else
 * fulfils directly — byte-behaviour identical to the previous unconditional
 * `__promise_fulfill` for non-thenables.
 */
export function buildPromiseResolveValueBody(resources: PromiseResolveValueResources): Instr[] {
  const {
    state,
    promiseTypeIdx,
    callbackTypeIdx,
    capsTypeIdx,
    thenable,
    target,
    exnTagIdx,
    selfResolutionStringInstrs,
    thenStringInstrs,
    thenGetStringInstrs,
    bagHasIdx,
    externGetIdx,
    typeofFunctionIdx,
    callableRootTypeIdx,
  } = validatePromiseResolveValueResources(resources);
  // The substrate ensured the exn tag (ensureExnTag) before this body builds.
  const promiseLocal = 0;
  const valueLocal = 1;
  const innerLocal = 2;
  const capsLocal = 3;
  const hasThenLocal = 4;
  const reasonLocal = 5;
  const poisonedLocal = 6;

  // (#3125) The non-$Promise arm: thenable check + job enqueue, or direct
  // fulfil. Falls back to the pre-#3125 direct fulfil when the substrate is
  // unavailable (defensive — host/gc never emits this helper).
  const nonPromiseArm: Instr[] =
    thenable === null
      ? [
          // not a promise: fulfil directly
          { op: "local.get", index: promiseLocal },
          { op: "local.get", index: valueLocal },
          { op: "call", funcIdx: state.promiseFulfillFuncIdx },
        ]
      : [
          // hasThen = __promise_has_callable_then(value) — the Get("then") runs
          // accessors, so a poisoned getter THROWS here (§27.2.1.3.2 step 9):
          // catch → reject(promise, thrown).
          buildTargetTaggedTry(
            target,
            { kind: "empty" },
            [
              { op: "local.get", index: valueLocal },
              { op: "call", funcIdx: thenable.hasCallableThenFuncIdx },
              { op: "local.set", index: hasThenLocal },
            ],
            [
              {
                tagIdx: exnTagIdx,
                body: [
                  { op: "local.set", index: reasonLocal },
                  { op: "i32.const", value: 1 },
                  { op: "local.set", index: poisonedLocal },
                ],
              },
            ],
          ),
          { op: "local.get", index: poisonedLocal },
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "externref" } },
            then: [
              // Get("then") threw: RejectPromise(promise, thrown).
              { op: "local.get", index: promiseLocal },
              { op: "local.get", index: reasonLocal },
              { op: "call", funcIdx: state.promiseRejectFuncIdx },
            ],
            else: [
              { op: "local.get", index: hasThenLocal },
              {
                op: "if",
                blockType: { kind: "val", type: { kind: "externref" } },
                then: [
                  // Callable then: enqueue PromiseResolveThenableJob(promise,
                  // value, then). caps = $__then_caps{callback: null, chained:
                  // promise}; the thenable rides the job's value slot (step 14
                  // — the then CALL happens as a job, never inline).
                  { op: "ref.func", funcIdx: thenable.thenableJobFuncIdx },
                  { op: "ref.null.extern" },
                  { op: "local.get", index: promiseLocal },
                  { op: "struct.new", typeIdx: capsTypeIdx },
                  { op: "extern.convert_any" },
                  { op: "local.get", index: valueLocal },
                  { op: "call", funcIdx: state.enqueueFuncIdx },
                  { op: "local.get", index: valueLocal },
                ],
                else: [
                  // Not a thenable: fulfil directly (steps 11 / 16).
                  { op: "local.get", index: promiseLocal },
                  { op: "local.get", index: valueLocal },
                  { op: "call", funcIdx: state.promiseFulfillFuncIdx },
                ],
              },
            ],
          },
        ];

  // (#3125) Step 6 — SameValue(resolution, promise): a promise resolved with
  // ITSELF rejects with a TypeError (resolve-settled-*-self). Emitted inside
  // the $Promise arm (both refs are concrete (ref $Promise), so a plain
  // `ref.eq` is the SameValue). Without the substrate the adopt path is kept
  // unchanged (pre-#3125: self-adoption deadlocks — defensive only).
  const selfCheck: Instr[] =
    thenable === null
      ? []
      : [
          { op: "local.get", index: innerLocal },
          { op: "local.get", index: promiseLocal },
          { op: "ref.eq" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: promiseLocal },
              ...structuredClone(selfResolutionStringInstrs),
              { op: "call", funcIdx: thenable.newTypeErrorFuncIdx },
              { op: "call", funcIdx: state.promiseRejectFuncIdx },
              { op: "drop" },
              { op: "local.get", index: valueLocal },
              { op: "return" },
            ],
          },
        ];

  // (#3125) Classify the PEELED resolution: an `any`-typed value arrives as an
  // externref-wrapped `$AnyValue` box, which would MISS the `ref.test $Promise`
  // and every thenable arm. The peel is dispatch-only — fulfil/reject still
  // deliver the ORIGINAL `value`, preserving identity across the promise.
  // (Placeholder peel = identity, so pre-fill behaviour is unchanged.)
  const peeledLocal = 7;
  const peelPrelude: Instr[] =
    thenable === null
      ? [
          { op: "local.get", index: valueLocal },
          { op: "local.set", index: peeledLocal },
        ]
      : [
          { op: "local.get", index: valueLocal },
          { op: "call", funcIdx: thenable.peelValueFuncIdx },
          { op: "local.set", index: peeledLocal },
        ];

  // (#5197 R3-5) §27.2.1.3.2 steps 8-13 run `Get(resolution, "then")` for EVERY
  // object, including a native promise. The `$Promise` arm below adopts the
  // native state directly, so `nativePromise.then = f` was never observed. The
  // decision rides on the VALUE (does this exact object carry an own `then` in
  // its carrier bag?), not on the syntax that produced it, so it is taken
  // identically however the promise reaches Resolve — a variable, a property,
  // an array element, a call result.
  //
  // Absent the carrier-bag natives (a module with no promise expandos at all)
  // this arm is not emitted and the body is byte-identical to before.
  const bagThenLocal = 8;
  // (#5197 round-3 review F2) IsCallable(thenAction) is the CLASSIFIER's
  // question, not a single root-wrapper `ref.test`: a bound function
  // (`$__bound_fn`), the runtime-eval carrier and the boundary callable are
  // callable and live outside the funcref-wrapper root. `__typeof_function`
  // is filled at finalize from the shared closure classifier
  // (closure-classifier.ts / typeof-natives-finalize.ts), so it also sees
  // callable carriers minted AFTER this body is built. The root test is kept
  // only as the fallback when the predicate cannot be registered.
  const isCallableThen: Instr[] =
    typeofFunctionIdx !== undefined
      ? [
          { op: "local.get", index: bagThenLocal },
          { op: "call", funcIdx: typeofFunctionIdx },
        ]
      : callableRootTypeIdx === undefined
        ? []
        : [
            { op: "local.get", index: bagThenLocal },
            { op: "any.convert_extern" },
            { op: "ref.test", typeIdx: callableRootTypeIdx },
          ];
  const ownThenArm: Instr[] =
    thenable === null || bagHasIdx === undefined || externGetIdx === undefined || isCallableThen.length === 0
      ? []
      : [
          { op: "local.get", index: peeledLocal },
          ...structuredClone(thenStringInstrs),
          { op: "call", funcIdx: bagHasIdx },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: peeledLocal },
              ...structuredClone(thenGetStringInstrs),
              { op: "call", funcIdx: externGetIdx },
              { op: "local.set", index: bagThenLocal },
              ...isCallableThen,
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  // Callable own `then`: enqueue PromiseResolveThenableJob with
                  // the function CAPTURED NOW (step 9), so a later reassignment
                  // of `then` cannot change which function the job calls.
                  { op: "ref.func", funcIdx: thenable.thenableJobFuncIdx },
                  { op: "local.get", index: bagThenLocal },
                  { op: "local.get", index: promiseLocal },
                  { op: "struct.new", typeIdx: capsTypeIdx },
                  { op: "extern.convert_any" },
                  { op: "local.get", index: valueLocal },
                  { op: "call", funcIdx: state.enqueueFuncIdx },
                  { op: "local.get", index: valueLocal },
                  { op: "return" },
                ],
                else: [
                  // Own but NOT callable (step 11): fulfil with the promise
                  // object itself, do not adopt its state.
                  { op: "local.get", index: promiseLocal },
                  { op: "local.get", index: valueLocal },
                  { op: "call", funcIdx: state.promiseFulfillFuncIdx },
                  { op: "return" },
                ],
              },
            ],
          },
        ];

  return [
    ...peelPrelude,
    { op: "local.get", index: peeledLocal },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: promiseTypeIdx },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "externref" } },
      then: [
        // inner = (ref $Promise) peeled
        { op: "local.get", index: peeledLocal },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: promiseTypeIdx },
        { op: "local.set", index: innerLocal },
        ...selfCheck,
        ...ownThenArm,
        // caps = $__then_caps{ callback: null, chained: promise }
        { op: "ref.null.extern" },
        { op: "local.get", index: promiseLocal },
        { op: "struct.new", typeIdx: capsTypeIdx },
        { op: "extern.convert_any" },
        { op: "local.set", index: capsLocal },
        // dispatch on inner.state
        { op: "local.get", index: innerLocal },
        { op: "struct.get", typeIdx: promiseTypeIdx, fieldIdx: resources.promiseFields.state },
        { op: "i32.const", value: PROMISE_STATE_FULFILLED },
        { op: "i32.eq" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            // already fulfilled: schedule fulfill reaction with inner.value
            { op: "ref.func", funcIdx: state.identityFulfillWrapperFuncIdx },
            { op: "local.get", index: capsLocal },
            { op: "local.get", index: innerLocal },
            { op: "struct.get", typeIdx: promiseTypeIdx, fieldIdx: resources.promiseFields.value },
            { op: "call", funcIdx: state.enqueueFuncIdx },
          ],
          else: [
            { op: "local.get", index: innerLocal },
            { op: "struct.get", typeIdx: promiseTypeIdx, fieldIdx: resources.promiseFields.state },
            { op: "i32.const", value: PROMISE_STATE_REJECTED },
            { op: "i32.eq" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                // already rejected: schedule reject reaction with inner.value
                { op: "ref.func", funcIdx: state.identityRejectWrapperFuncIdx },
                { op: "local.get", index: capsLocal },
                { op: "local.get", index: innerLocal },
                { op: "struct.get", typeIdx: promiseTypeIdx, fieldIdx: resources.promiseFields.value },
                { op: "call", funcIdx: state.enqueueFuncIdx },
              ],
              else: [
                // pending: prepend a reaction node onto inner.callbacks
                { op: "local.get", index: innerLocal },
                { op: "ref.func", funcIdx: state.identityFulfillWrapperFuncIdx },
                { op: "local.get", index: capsLocal },
                { op: "ref.func", funcIdx: state.identityRejectWrapperFuncIdx },
                { op: "local.get", index: capsLocal },
                { op: "local.get", index: innerLocal },
                { op: "struct.get", typeIdx: promiseTypeIdx, fieldIdx: resources.promiseFields.callbacks },
                { op: "struct.new", typeIdx: callbackTypeIdx },
                { op: "extern.convert_any" },
                { op: "struct.set", typeIdx: promiseTypeIdx, fieldIdx: resources.promiseFields.callbacks },
              ],
            },
          ],
        },
        // result (unused by the microtask drain, but the type must be externref)
        { op: "local.get", index: valueLocal },
      ],
      else: nonPromiseArm,
    },
  ];
}

function validatePromiseResolveValueResources(resources: PromiseResolveValueResources): PromiseResolveValueResources {
  if (
    resources.callbackFields?.join(",") !== "0,1,2,3,4" ||
    resources.capsFields?.callback !== 0 ||
    resources.capsFields?.chained !== 1
  )
    throw new Error("Promise resolution requires canonical callback/capture field order");
  return resources;
}

export interface PromiseSettleClosureResources {
  readonly capTypeIdx: TypeHandle;
  readonly capMetaTypeIdx: TypeHandle;
  readonly capPromiseFieldIdx: number;
}
export function buildPromiseSettleClosureValue(
  closures: PromiseSettleClosureResources,
  clFuncIdx: FuncHandle,
  promiseInstrs: readonly Instr[],
): Instr[] {
  if (closures.capPromiseFieldIdx !== 5)
    throw new Error("Promise settle closure requires function/arity/bag/state/metadata/capture layout");
  return [
    { op: "ref.func", funcIdx: clFuncIdx },
    { op: "i32.const", value: 1 }, // (#3673) $arity — settle fns take 1 arg
    { op: "ref.null.extern" }, // (#4241) $bag
    // (#5197) `bfnstate` delete-bits + the `bfnid` metadata anchor, in the
    // layout `ensureBuiltinFnMetaType` fixed. Both settle functions share ONE
    // metadata entry because §27.2.1.3.1/.2 give them identical `{name: "",
    // length: 1}`; the id therefore selects that single entry for both.
    { op: "i32.const", value: 0 },
    { op: "i32.const", value: closures.capMetaTypeIdx },
    ...promiseInstrs,
    { op: "struct.new", typeIdx: closures.capTypeIdx },
  ];
}

export function buildPromiseSettleClosureBody(
  resources: PromiseSettleClosureResources,
  settleFuncIdx: FuncHandle,
): Instr[] {
  const { capTypeIdx, capPromiseFieldIdx } = resources;
  return [
    { op: "local.get", index: 0 }, // self: (ref $wrapperRoot)
    { op: "ref.cast", typeIdx: capTypeIdx }, // downcast to the cap subtype (non-null)
    { op: "struct.get", typeIdx: capTypeIdx, fieldIdx: capPromiseFieldIdx }, // captured (ref $Promise)
    { op: "local.get", index: 1 }, // value: externref
    { op: "call", funcIdx: settleFuncIdx }, // settle -> externref
    { op: "drop" }, // trampoline result type is () — discard the settled value
  ];
}
export interface PromiseThenableJobResources {
  readonly target: { wasi: boolean; standalone: boolean };
  readonly promiseTypeIdx: TypeHandle;
  readonly promiseRejectFuncIdx: FuncHandle;
  readonly capsTypeIdx: TypeHandle;
  readonly capsFields: { readonly callback: number; readonly chained: number };
  readonly objVecNewIdx: FuncHandle;
  readonly objVecPushIdx: FuncHandle;
  readonly execClosures: PromiseSettleClosureResources & {
    readonly resolveClFuncIdx: FuncHandle;
    readonly rejectClFuncIdx: FuncHandle;
  };
  readonly applyClosureIdx: FuncHandle | undefined;
  readonly peelValueFuncIdx: FuncHandle;
  readonly varargThenFuncIdx: FuncHandle;
  readonly exnTag: number;
}
export function buildPromiseThenableJob(resources: PromiseThenableJobResources): { locals: LocalDef[]; body: Instr[] } {
  const {
    target,
    capsTypeIdx,
    capsFields,
    objVecNewIdx,
    objVecPushIdx,
    execClosures,
    applyClosureIdx,
    peelValueFuncIdx,
    varargThenFuncIdx,
    exnTag,
  } = resources;
  const state = resources;
  const promiseLocal = 2;
  const reasonLocal = 3;
  const vecLocal = 4;
  const capturedThenLocal = 5;
  // (#5197 R3-5) `__apply_closure(fn, recv, argvec)` — the open closure-call
  // bridge. Reserved here so the funcIdx is stable before this body bakes it.
  const jobLocals: LocalDef[] = [
    { name: "$promise", type: { kind: "ref_null", typeIdx: state.promiseTypeIdx } },
    { name: "$reason", type: { kind: "externref" } },
    { name: "$argvec", type: { kind: "externref" } },
    { name: "$capturedThen", type: { kind: "externref" } },
  ];
  const emitSettleCap = (clFuncIdx: number): Instr[] => [
    ...buildPromiseSettleClosureValue(execClosures, clFuncIdx, [
      { op: "local.get", index: promiseLocal },
      { op: "ref.as_non_null" },
    ]),
    { op: "extern.convert_any" },
  ];
  const jobTryBody: Instr[] = [
    // argvec = [resolveFn, rejectFn]
    { op: "call", funcIdx: objVecNewIdx },
    { op: "local.set", index: vecLocal },
    { op: "local.get", index: vecLocal },
    ...emitSettleCap(execClosures.resolveClFuncIdx),
    { op: "call", funcIdx: objVecPushIdx },
    { op: "local.get", index: vecLocal },
    ...emitSettleCap(execClosures.rejectClFuncIdx),
    { op: "call", funcIdx: objVecPushIdx },
    // __call_m_then_vararg(peel(thenable), argvec) — `then.call(thenable,
    // res, rej)`. The peel unwraps an `$AnyValue`-boxed resolution so the
    // dispatcher's `ref.test` arms (closed structs / `$Object`) see the RAW
    // object as the receiver.
    // (#5197 R3-5) When Resolve captured the `then` FUNCTION (an own `then` on
    // a native promise), call THAT value — the spec captures `then` at Resolve
    // time (step 9) and calls it as a job (step 14), so a reassignment between
    // the two must not change which function runs. Otherwise re-dispatch
    // through the vararg `then` method dispatcher exactly as before.
    ...(applyClosureIdx === undefined
      ? [
          { op: "local.get", index: 1 } as Instr,
          { op: "call", funcIdx: peelValueFuncIdx } as Instr,
          { op: "local.get", index: vecLocal } as Instr,
          { op: "call", funcIdx: varargThenFuncIdx } as Instr,
        ]
      : ([
          { op: "local.get", index: 0 },
          { op: "any.convert_extern" },
          { op: "ref.cast", typeIdx: capsTypeIdx },
          { op: "struct.get", typeIdx: capsTypeIdx, fieldIdx: capsFields.callback },
          { op: "local.tee", index: capturedThenLocal },
          { op: "ref.is_null" },
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "externref" } },
            then: [
              { op: "local.get", index: 1 },
              { op: "call", funcIdx: peelValueFuncIdx },
              { op: "local.get", index: vecLocal },
              { op: "call", funcIdx: varargThenFuncIdx },
            ],
            else: [
              { op: "local.get", index: capturedThenLocal },
              { op: "local.get", index: 1 },
              { op: "call", funcIdx: peelValueFuncIdx },
              { op: "local.get", index: vecLocal },
              { op: "call", funcIdx: applyClosureIdx },
            ],
          },
        ] satisfies Instr[])),
    { op: "drop" },
  ];
  return {
    locals: jobLocals,
    body: [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: capsTypeIdx },
      { op: "struct.get", typeIdx: capsTypeIdx, fieldIdx: capsFields.chained },
      { op: "local.set", index: promiseLocal },
      buildTargetTaggedTry(target, { kind: "empty" }, jobTryBody, [
        {
          tagIdx: exnTag,
          body: [
            // A throw from Get/then-call before settle rejects the promise
            // (§27.2.2.2 step 2 / §27.2.1.3.2 step 15). Post-settle throws
            // are no-ops via the one-shot settle guard.
            { op: "local.set", index: reasonLocal },
            { op: "local.get", index: promiseLocal },
            { op: "ref.as_non_null" },
            { op: "local.get", index: reasonLocal },
            { op: "call", funcIdx: state.promiseRejectFuncIdx },
            { op: "drop" },
          ],
        },
      ]),
      { op: "ref.null.extern" },
    ],
  };
}
