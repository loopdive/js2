# Native Promise settlement implementation plan

Astra High source-grounded specification; implementation remains pending.

## Recommended next move

Move the **native Promise settlement and identity-reaction body family** into `src/runtime/wasmgc/promise/settlement-bodies.ts`, with real calls from the existing scheduler.

This is independently implementable after A finishes source acceptance; it does not depend on B’s new allocator API. It moves executable bodies used by native async today, while leaving allocation and finalization authority unchanged.

Inspected parent: `e3de0f3ff7d7828c66b3fea7946f08e593bf77d8`. No tests or edits.

## Exact declaration map

From [async-scheduler.ts](../../src/codegen/async-scheduler.ts):

- `buildPromiseSettleLocals` — line1106.
- `buildPromiseSettleBody` — line1114.
- `buildIdentityWrapperLocals` — line1217.
- `buildIdentityWrapperBody` — line1225.
- The instruction-construction implementation of `buildDenoPromiseHookCall` — line87. Keep its existing context-taking public adapter.
- `PROMISE_STATE_PENDING`, `PROMISE_STATE_FULFILLED`, `PROMISE_STATE_REJECTED`.
- `DENO_PROMISE_HOOK_INIT`, `DENO_PROMISE_HOOK_BEFORE`, `DENO_PROMISE_HOOK_AFTER`, `DENO_PROMISE_HOOK_RESOLVE`.

From [unhandled-rejection.ts:151](../../src/codegen/unhandled-rejection.ts):

- The implementation of `buildNoteUnhandledRejection`; retain the old public signature as a downward adapter.

That is **six function implementations plus seven constant declarations**. No classes or class initializers move. Keep explicit old constant reexports.

The original source-qualified `[path,name,JSDoc,text]` thirteen-record receipt, in source order, hashes to:

`cbd5fdf3e0bddf7af4bf4b361302ff34f0457e6980ed36d388f42a78d087595c`

This is an additive relocation denominator, not a replacement for existing ledgers.

## Explicit canonical inputs

The canonical module imports only existing Wasm instruction/model types. No `CodegenContext`, `AsyncSchedulerState`, registry, provider catalog, or legacy facade—even through type imports.

Use these narrow resource shapes:

```ts
type PromiseHookResources =
  | undefined
  | {
      readonly dispatchFuncIdx: FuncHandle;
      readonly parentExternInstrs: readonly Instr[];
    };

interface PromiseSettleResources {
  readonly promiseTypeIdx: TypeHandle;
  readonly callbackTypeIdx: TypeHandle;
  readonly enqueueFuncIdx: FuncHandle;
  readonly resolveHook: PromiseHookResources;
  readonly unhandledHeadGlobalIdx: number;
  readonly unhandledNodeTypeIdx: number;
}

interface IdentityReactionResources {
  readonly capsTypeIdx: TypeHandle;
  readonly settleFuncIdx: FuncHandle;
  readonly beforeHook: PromiseHookResources;
  readonly afterHook: PromiseHookResources;
}
```

Canonical signatures:

- `buildPromiseSettleLocals(callbackTypeIdx): LocalDef[]`
- `buildPromiseSettleBody(resources, settledState): Instr[]`
- `buildIdentityWrapperLocals(capsTypeIdx): LocalDef[]`
- `buildIdentityWrapperBody(resources): Instr[]`
- `buildDenoPromiseHookCall(resources, kind, promiseInstrs): Instr[]`
- `buildNoteUnhandledRejection({ unhandledHeadGlobalIdx, unhandledNodeTypeIdx }, promiseInstrs): Instr[]`

Keep `settledState` restricted to the existing fulfilled/rejected constant types. Preserve the existing negative-index tracking checks rather than collapsing partially populated states into a newly simplified union.

`parentExternInstrs` is an explicit, already-materialized Wasm operand—not a callback or a general emission escape hatch. Its legacy producer must remain precisely the existing canonical-undefined expression or supplied parent-reference conversion.

### Important allocation-order constraint

`canonicalUndefinedExternInstrs(ctx)` can reserve native value resources. Therefore:

- Resolve hook resources **at each existing hook construction point**, not eagerly at the beginning of `ensurePromiseSettleFunctions`.
- Check dispatcher absence before materializing undefined.
- Preserve separate before/after dispatcher lookups and parent-expression construction.
- Capture settlement state fields after the resolve-hook preparation, matching current evaluation order.
- Keep the identity wrapper’s already-passed `settleFuncIdx` unchanged across hook preparation.
- Do not share mutable instruction nodes between independently constructed hook expressions.

Keep the public `buildDenoPromiseHookCall(ctx, kind, promiseInstrs, parentInstrs?)` signature. Its adapter performs the existing lookup and operand preparation, then calls the canonical instruction builder.

## Real consumer rewiring

[ensurePromiseSettleFunctions:591](../../src/codegen/async-scheduler.ts) remains the allocator:

- `__promise_fulfill` uses canonical settlement locals/body.
- `__promise_reject` uses the same canonical builders with rejected state.
- `__then_identity_fulfill` uses canonical identity builders targeting **`promiseResolveValueFuncIdx`**.
- `__then_identity_reject` targets **`promiseRejectFuncIdx`**.

Do not replace identity fulfillment with direct fulfillment: that would break recursive Promise adoption.

Preserve the existing sequence:

1. Queue registration.
2. Unhandled-rejection registration.
3. Promise/callback/capture types and settle signature.
4. Five existing handle mints, including early resolve-value reservation.
5. Existing four function registrations, in their current order.
6. Thenable-substrate preparation.
7. Resolve-value body registration.

The prepared production chain already reaches these functions:

`materializePreparedAsyncHostAdapters → ensureAsyncDriveRuntime → ensurePromiseSettleFunctions`

Native delay also reaches `ensureAsyncDriveRuntime`. Settlement enqueues callbacks through the **already extracted queue**, whose drain invokes the existing frame step adapters and resume function. No synthetic caller or new dispatch framework is needed.

Other hook callers—including `promise-executor.ts`, ordinary `.then` wrappers and finally machinery—continue through the unchanged public adapter. Direct `Promise.reject` continues through the old unhandled-note adapter.

## Semantics and ownership that must remain exact

Pin these behaviors in body receipts and execution:

- Resolve hook runs **before** the one-shot guard, including repeated resolution.
- Repeated settlement returns the attempted value without changing original state/value.
- Callback list is detached before enqueueing.
- Fulfillment uses callback fields0/1; rejection uses2/3; next-link remains4.
- Unhandled tracking occurs only for rejected settlement with no detached callbacks and the existing enabled-state conditions.
- Identity hooks observe the chained Promise; `after` remains after normal settlement return, not in a newly introduced `finally`.
- Locals, branch depths, returned values and instruction order remain unchanged.

No scheduler cache, WeakMap, allocator object, registry, or publication state moves. `getOrInitState`, type registrations, `funcMap` writes and side-channel shifting remain authoritative where they are.

No frame code changes: preserve `currentFunc` restoration, detached `liveBodies`, frame ownership records and post-pass runtime-state traversal.

## Bounded write set

Low A:

1. `src/runtime/wasmgc/promise/settlement-bodies.ts` — new executable owner.
2. `src/codegen/async-scheduler.ts` — imports, explicit reexports, resource-binding adapters and four real body call sites.
3. `src/codegen/unhandled-rejection.ts` — downward adapter only.
4. `tests/issue-3518-promise-settlement-body-ownership.test.ts` — relocation, closure and mutation controls.
5. `tests/issue-3518-promise-settlement-source-preservation.test.ts` — paired source-produced evidence.

Parent owns canonical-root activation and boundary controls. No allowed-edge widening is needed. This set does not overlap B’s physical-kernel files or the parent consumer/physical-plan files.

Keep all five queue-builder imports and their existing six-target N1 preservation contract unchanged.

## Required proof

Ownership/control tests must establish:

- Mandatory canonical file and six implementations; deletion cannot disable coverage.
- Exact thirteen original declaration receipts, allowing only explicitly enumerated resource-binding/signature changes.
- No duplicated body implementation left in adapters.
- Missing/renamed canonical imports, changed constants, reordered settlement operations and swapped fulfillment/rejection targets fail.
- Dispatcher absence performs no undefined-resource allocation.
- Before/after expressions preserve separate construction and do not introduce shared mutable instruction nodes.
- Canonical runtime import closure excludes codegen, frontend, old IR facades and allocator callbacks.

Use real source fixtures already present:

- `issue-4573-standalone-native-promise-delay.test.ts`.
- `issue-4574-standalone-native-async-family.test.ts`: suspension, **70**, non-i31 **3e9**, rejection and canonical undefined.
- `deno-promise-hooks-standalone.test.ts`: dispatcher-present lifecycle ordering and dispatcher-absent inertness.
- Adoption sources from `issue-2867.test.ts`; retain their existing lane evidence distinctly.
- Existing `issue-2958.test.ts` for preserved tracking behavior—no new WASI implementation.

Compare complete binary/WAT and resource order against `e3de0f3ff7`, plus executed timer/value/hook traces. Structural body tests do not substitute for those source callers.

## Explicitly blocked dependent bodies

Do **not** include `buildPromiseResolveValueBody` in this dispatch. Its name conceals additional production work:

- Materializes self-resolution and `"then"` string expressions.
- May call `ensureLateImport("__typeof_function", …)`.
- Reads carrier-bag, extern-get and closure-root availability.
- Selects target-specific exception scaffolding.
- References deferred thenable/classifier helpers whose final bodies depend on complete object/closure inventories.

Leave `buildPromiseResolveValueLocals` with that body. Also retain executor-closure allocation, `ensurePromiseThenableSubstrate`, thenable finalizers, frame builders and timer publication unchanged.

Thus this checkpoint completes a **real reusable settlement/reaction body family**, not the full Promise runtime. Whole-program delay/frame acceptance still waits for resource materialization, resolve/adoption closure, numeric/undefined support and the prepared frame adapter. The full native family and eventual public IR-only cutover remain mandatory.
