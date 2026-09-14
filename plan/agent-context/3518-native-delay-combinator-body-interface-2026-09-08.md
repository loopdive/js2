## Dispatch contract

Pinned source: `e3a01efa44f68da1b93c16b1a728d0ba099183f9`. This refines section 4 only: move executable delay/combinator construction into canonical runtime modules and reconnect existing production callers. No source-producer, vector, provider-catalog or physical-admission changes.

### 1. Exact ownership

Low B production writes:

- New `src/runtime/wasmgc/promise/delay-bodies.ts`
- New `src/runtime/wasmgc/promise/combinator-bodies.ts`
- Existing `src/codegen/ir-native-promise-delay.ts`
- Existing `src/codegen/promise-combinators.ts`
- Existing `src/codegen/ir-native-async-runtime.ts` — compatibility/provider integration only; retain its lifecycle.

Proposed test writes:

- `tests/issue-3518-native-delay-combinator-body-ownership.test.ts`
- `tests/issue-3518-native-delay-combinator-source-preservation.test.ts`
- `tests/helpers/native-delay-combinator-source-receipts.mjs`

Parent owns additive boundary activation, historical receipt adaptation and publication. Active source/vector writers remain disjoint.

Canonical modules import model types directly from `wasm/model/instructions.ts` and reuse Promise state constants from `runtime/wasmgc/promise/settlement-bodies.ts`. No imports from `codegen`, frontend IR facades, context, registry or scheduler—even type-only.

## 2. Delay builders and resources

Donor: [ir-native-promise-delay.ts:85](/private/tmp/js2-3518-delay-admission-integration-20260908/src/codegen/ir-native-promise-delay.ts:85).

Freeze these new exports:

```ts
buildNativePromiseDelayCallbackLocals(): LocalDef[]
buildNativePromiseDelayCallbackBody(
  resources: NativePromiseDelayCallbackResources,
): Instr[]

buildNativePromiseDelayProviderLocals(
  promiseTypeIdx: TypeHandle,
): LocalDef[]
buildNativePromiseDelayProviderBody(
  resources: NativePromiseDelayProviderResources,
): Instr[]
```

All resource fields readonly:

```ts
interface NativePromiseDelayCaptureLayout {
  captureTypeIdx: TypeHandle;
  promiseFieldIdx: 3;
  valueFieldIdx: 4;
}

interface NativePromiseDelayCallbackResources {
  capture: NativePromiseDelayCaptureLayout;
  boxNumberFuncIdx: FuncHandle;
  resolveValueFuncIdx: FuncHandle;
}

interface NativePromiseDelayProviderResources {
  promiseTypeIdx: TypeHandle;
  capture: NativePromiseDelayCaptureLayout;
  timerCallbackFuncIdx: FuncHandle;
  timerFuncIdx: FuncHandle;
  boxNumberFuncIdx: FuncHandle;
  rejectFuncIdx: FuncHandle;
  exnTagIdx: number;
  callbackArity: 0;
  bagInit: { readonly op: "ref.null.extern" };
}
```

These are explicit projections of existing resources, not a new allocator or authentication authority. The adapter obtains bag initialization from the existing closure-header factory, verifies its narrow opcode, and passes the data; builders create fresh initializer instructions. Do not import or duplicate the mixed closure registry.

Exact outputs:

- Callback: no locals; parameter 0 is the existing lifted wrapper **root reference**, not an invented externref parameter. Cast to capture, read Promise field 3 and numeric value field 4, box value, resolve-value, drop.
- Provider: parameters 0/1 remain `ms/value: f64`; local 2 `$promise: ref Promise`, local 3 `$reason: externref`; result externref.
- Preserve pending Promise allocation before timer registration.
- Preserve capture operands: callback funcref, zero arity, bag, Promise, numeric value.
- Preserve tagged catch payload and foreign-exception null-sentinel rejection separately.
- Do not replace resolve-value with fulfill or inline number boxing.

Wrapper root, lifted signature, capture subtype registration and allocation observation remain adapter-owned. In particular, retain `getOrCreateFuncRefWrapperTypes(..., "host-one-shot")`: it updates existing closure allocation metadata even on cache hits.

## 3. Eight combinator donors

All eight are in [promise-combinators.ts:788](/private/tmp/js2-3518-delay-admission-integration-20260908/src/codegen/promise-combinators.ts:788). Keep their names as canonical exports; old private compatibility names may import them under aliases.

Exact mapping and signatures:

```ts
buildSubscribeLocals(promiseTypeIdx: TypeHandle): LocalDef[]
buildSubscribeBody(resources: CombinatorSubscriptionResources): Instr[]

buildAllFulfillLocals(types: CombinatorCaptureTypes): LocalDef[]
buildAllFulfillBody(resources: CombinatorAllFulfillResources): Instr[]

buildSettleWrapperLocals(types: CombinatorCaptureTypes): LocalDef[]
buildSettleResultBody(
  types: CombinatorCaptureTypes,
  settleFuncIdx: FuncHandle,
): Instr[]

buildRaceFulfillBody(
  types: CombinatorCaptureTypes,
  fulfillFuncIdx: FuncHandle,
): Instr[]
buildRejectBody(
  types: CombinatorCaptureTypes,
  rejectFuncIdx: FuncHandle,
): Instr[]
```

Readonly resource fields:

- `CombinatorCaptureTypes`: `elemCapsTypeIdx`, `stateTypeIdx`, both `TypeHandle`.
- `CombinatorSubscriptionResources`: capture types plus `promiseTypeIdx`, `callbackTypeIdx`, `enqueueFuncIdx`, **required** `resolveValueFuncIdx`, `markRejectionHandledFuncIdx: FuncHandle | undefined`, and the narrow `bagInit` operand above.
- `CombinatorAllFulfillResources`: capture types plus `arrTypeIdx`, `vecTypeIdx`, `fulfillFuncIdx`.

Local/result contracts remain:

- Subscribe parameters 0–4: input, state, index, fulfill funcref, reject funcref. Locals 5 `$p`, 6 `$caps`. No result.
- All-fulfill parameters 0/1: caps/value; locals 2 `$c`, 3 `$st`, 4 `$rem`; returns the original value.
- Settle wrappers: parameters caps/value; locals 2 `$c`, 3 `$st`; return the settlement call’s result. Do not add a drop.
- Race/reject remain thin callers of the **single** `buildSettleResultBody`.

### Required normalization split

The canonical `buildSubscribeBody` must reject missing/negative resolve-value resources; zero is a valid handle. Actual module ownership/signature is established by the resource binder, not by the numeric alias alone.

Preserve the existing `-1` fallback only in the old compatibility adapter. Avoid duplicating the subscription algorithm:

- Add canonical `buildSubscribeDispatchBody`, accepting subscription resources **without** `resolveValueFuncIdx` or `bagInit`.
- It starts after local 5 has been initialized: construct element caps, mark handled when provided, inspect state, enqueue settled reactions or link the pending callback.
- Canonical `buildSubscribeBody` emits the existing real-Promise/resolve-value normalization prefix, then that shared suffix.
- The old fallback emits its existing normalization prefix with the synchronously fulfilled wrapper, then calls the same suffix.

This adds one explicitly counted helper; it does not replace the historical eight-donor denominator. No arbitrary normalization callback or public “fallback mode” enters the canonical contract.

Existing `allSettled`/`any` registration and method selection remain compatibility-owned. Their use of shared locals, race fulfillment and rejection bodies must remain connected.

## 4. Detached runtime-vector loop

Donor: [emitStandalonePromiseCombinatorRuntime:1391](/private/tmp/js2-3518-delay-admission-integration-20260908/src/codegen/promise-combinators.ts:1391).

Freeze:

```ts
buildNativePromiseCombinatorVectorBody(
  resources: NativePromiseCombinatorVectorResources,
  locals: NativePromiseCombinatorVectorLocals,
  rejectedInput?: {
    readonly notIterLocal: number;
    readonly rejectReason: readonly Instr[];
  },
): Instr[]
```

`NativePromiseCombinatorVectorLocals` contains exactly:

- `argVecLocal`
- `resultLocal`
- `arrLocal`
- `stateLocal`
- `nLocal`
- `iLocal`

Resource fields:

- Types: `promiseTypeIdx`, `stateTypeIdx`, `arrTypeIdx`, `vecTypeIdx`, `argVecTypeIdx`, `argArrTypeIdx`.
- Functions: `subscribeFuncIdx`, `fulfillReactionFuncIdx`, `rejectReactionFuncIdx`, `fulfillFuncIdx`, `rejectFuncIdx`.
- Narrow `bagInit`.
- `emptyResult`, a closed union:
  - `{ kind: "fulfill-vector" }`
  - `{ kind: "pending" }`
  - `{ kind: "reject-aggregate"; aggregateErrorFuncIdx: FuncHandle }`

Compatibility mapping is all/allSettled → fulfill-vector, race → pending, any → reject-aggregate. This retains shared behavior without moving method lookup or lazy registration into runtime.

The builder allocates no locals, changes no state and leaves one externref on the operand stack; it appends no function return.

Preserve:

- Logical vector length from field 0, not backing capacity.
- Result Promise → results array → state allocation order.
- Invalid-iterable rejection before empty handling.
- State `{resultPromise, resultsArr, length, remaining}` and decrement/store ordering.
- Loop exit depth 1 and backedge depth 0.
- Input-order subscription; settled inputs enqueue rather than synchronously invoke reactions.

## 5. Live mutation and lifecycle obligations

### Existing adapter remains the resource owner

`ensureCombinatorFunctions` keeps, in order:

1. Cache lookup.
2. Async runtime registration.
3. Promise/vector/array resolution.
4. State and element-capture registration.
5. Function signatures.
6. Four independent stable-handle mints.
7. Subscribe, all-fulfill, race-fulfill, reject push/map publication.
8. Cache publication.

Keep `mod.types`, `structMap`, `typeIdxToStructName`, `structFields`, function allocator and `funcMap` updates unchanged. No `base + ordinal` handle arithmetic.

`combinatorReactionFns` and optional allSettled/any registration must finish before resource projection and body construction. Do not cache a copied resource projection across later registrations: existing side-channel index updates mutate the cached combinator object.

### Detached buffer has a deliberately short lifetime

The old vector emitter must:

1. Complete all registrations and reaction selection.
2. Allocate five locals with existing `allocLocal`, in result/array/state/n/i order.
3. Preserve each generated name’s use of the then-current `fctx.locals.length`.
4. Build and immediately append with `fctx.body.push(...body)`.

No registration, callback, await or other allocating operation may intervene between building and appending. Never replace `fctx.body`, `locals`, `localMap`, `savedBodies` or `liveBodies`. Once appended, existing late-import traversal retains responsibility.

### Native wrappers

[ensureIrNativePromiseAllProvider:58](/private/tmp/js2-3518-delay-admission-integration-20260908/src/codegen/ir-native-async-runtime.ts:58) retains its actual FunctionContext, `currentFunc` assignment and `finally` restoration—including the identical thrown object. Provider minting remains after successful body construction; cache publication and exact ABI checks retain their order.

Delay retains registration order, callback-before-provider publication, the existing provider map/push order, occupied-handle check, timer-dispatch flag and final cache assignment. No new rollback behavior.

The real production chains remain `integration.resolveAndObserveCallableProvider` → existing delay/all adapter → canonical builders. No test-only callers substitute for these chains.

## 6. Preservation and acceptance

Required controls:

- Reconstruct all eight historical donor bodies, including wrappers; separately account for extracted delay inline bodies/locals and the vector loop. Preserve original hashes/denominators through explicit split reconstruction, not reseeding.
- Pin capture/header fields, initializer counts/order, locals and exact complete instruction trees. Include live body/order mutations.
- Missing resolve-value fails canonically; legacy fallback remains adapter-only. Test handle zero and absent rejection-handled notification.
- Exercise real thenable assimilation and rejection, all ordering, shared race/allSettled/any behavior, empty vectors, grown backing capacity and invalid-iterable-before-empty rejection.
- Test nonzero parameter/local bases, immediate append identity, late-registration/index preservation, repeated cache identity and exact-error `currentFunc` restoration.
- Source evidence must include existing #4573 and all eight #4574 behavioral scenarios: numeric 70, non-i31 fulfillment, sequential scheduling, reverse-order parallel fulfillment, both empty paths, sequential failure, parallel failure, and main logging/undefined.
- Paired pinned-baseline/candidate evidence compares complete bytes/WAT/resource order and actual execution. Default tests are self-contained; explicit historical runs report terminal failures without silent skips or automatic child killing.

Parent adds both canonical files as mandatory runtime roots with missing-file and forbidden type/value-import controls; existing preservation groups and activation history remain intact.

No unresolved architectural choice blocks this extraction. It creates reusable executable bodies through genuine callers, but does **not** complete provider binding or whole-program async physical admission. Source/vector preparation, complete resource materialization, frame integration, public cutover and the unresolved ABI30 witness remain separate obligations. No tests or writes were performed for this specification.
