# Native async whole-program physical cutover plan

Source review by Astra High, 2026-09-08. This is the next implementation plan, not an acceptance or retirement result.

The next cutover should be **whole-program native async emission with an explicit physical-resource transaction**, not removal of the async guard. The working public path supplies substantial runtime machinery that `program-consumer.ts` currently neither inventories nor reserves.

Inspected integration HEAD: `b4c116639a7e146e83611a988a8da28d77de9368`, including its composed changes. Read-only source inspection and lightweight AST projection only; no execution claims beyond the reported paired **14/14 + 14/14**.

## 1. What the working path actually does

The production connection is:

`ir/integration.ts#prepareBuiltFnRuntimeManifest`
→ `materializePreparedAsyncHostAdapters`
→ native runtime reservation
→ vector/support preparation and ABI binding
→ `lowerIrEntryFunction`
→ `lowerPreparedIrAsyncFunction`
→ shared frame engine.

Key implementation sites:

- [integration.ts:1471](../../src/ir/integration.ts#L1471): materializes selected async requirements before lowering.
- [ir-async-runtime-adapters.ts:138](../../src/codegen/ir-async-runtime-adapters.ts#L138): authenticates attachments, validates target policy, reserves drive/number/undefined resources.
- [ir-async-frame.ts:387](../../src/codegen/ir-async-frame.ts#L387): requires an already allocated Promise-returning function, builds its frame, lowers **runtime-state bodies**, and restores `currentFunc` in `finally`.
- [async-frame.ts:1614](../../src/codegen/async-frame.ts#L1614): reserves resume/fulfill-step/reject-step functions, then fills the state machine.

The prepared route supplies no AST statements to that engine, but the engine’s module and shared coercion helpers still import frontend/direct-generation machinery. Calling its “prepared” entry is therefore not a clean backend boundary.

## 2. Why blind guard removal is unsafe

[program-consumer.ts:278](../../src/ir/program-consumer.ts#L278) currently reserves ordinary functions/imports/globals, freezes the index space, binds the ABI, and sends every function through generic synchronous lowering.

Removing [the guard](../../src/ir/program-physical-plan.ts#L173) would leave:

- No async-specific lowering dispatch or frame/resume/step slots.
- No Promise, reaction, queue, numeric-bridge or undefined resources.
- A Promise-returning callable contract paired with ordinary body-result lowering.
- A resolver whose `resolveType` always fails and which lacks vector/string/materialization support.
- Dependency and exception scans over blocks/semantic async states, **not the selected runtime-state bodies**.
- No ownership receipt for generated support functions: the final emission census currently permits only planned unit bodies and the startup adapter.
- No native timer dispatcher publication or late-finalizer completion protocol.

Backend legality currently inspects ordinary blocks; it is not a substitute for prepared-frame capability validation.

## 3. Required physical dependency closure

### Drive and settlement

[async-scheduler.ts:2311](../../src/codegen/async-scheduler.ts#L2311), `ensureAsyncDriveRuntime`, calls:

- `ensureMicrotaskQueue`: array/callback types, **six globals**, grow/enqueue/drain functions.
- `ensurePromiseSettleFunctions`: Promise/reaction/capture types; fulfill/reject, identity reactions and resolve-value functions.
- Settlement/adoption dependencies: executor closures, TypeError construction, exception tag, pooled strings and thenable dispatch.

The five queue-body builders already exist under `src/runtime/wasmgc/async/microtask-queue-bodies.ts`. **Reuse them; do not dispatch another queue-body extraction.** Queue capacity remains the existing 8192.

Crucially, `ensurePromiseThenableSubstrate` installs placeholders later filled by `fillPromiseThenableHelpers` and closed-method dispatch. A nonempty, valid Wasm placeholder is not completed runtime materialization.

### Values and observable boundaries

`prepareNativePromiseNumberBoundary` calls the registered union-runtime allocator and publishes `__typeof_number`/`__unbox_number`. Frame coercion and the delay provider also require number boxing.

Canonical undefined requires the existing native value type and singleton global; substituting `ref.null.extern` changes undefined into null. Preserve non-i31 values such as **3e9**, not merely an i31 fast path.

### Timers and the complete family

[ir-native-promise-delay.ts:85](../../src/codegen/ir-native-promise-delay.ts#L85) additionally needs:

- Explicit timer import, exception tag, number boxer and resolve-value function.
- Canonical closure-wrapper type, timer capture type and callback function.
- `publishStandaloneTimerCallbackDispatch`: allocator-owned dispatcher, tables/elements, manifest global and collision-safe exports.

Promise.all additionally uses `ensureCombinatorFunctions` and `emitStandalonePromiseCombinatorRuntime`: externref vector/array layouts, combinator state/capture types and reaction functions.

The full main path also requires native number formatting, concat-family providers, string storage and stdout support. Its standalone clock snapshot must retain the existing constant projection.

### Prepared ABI gaps precede physical emission

[program-runtime-abi.ts:43](../../src/ir/program-runtime-abi.ts#L43) admits runtime calls through canonical declarations. That declaration resolver currently recognizes only `__new_ReferenceError`; native delay/Promise.all symbols cannot simply be resolved by the backend afterward.

Extend the existing declaration/ABI pipeline with exact contracts for demanded native callables. Preserve source anchoring, structural binding keys and original owners. Frame support identities should retain the existing owner-relative roles: resume0, fulfill1, reject2—not names or surviving function positions.

Vector layouts require a separate backend-bound view. Do not mutate the frozen prepared program: [runtime projection validation](../../src/ir/program-runtime-validation.ts#L40) reproduces its complete semantic/provider data. Preserve exact logical-type identity and validate any existing layout attachment against the derived physical view.

## 4. Context state that must become explicit

This is the inspected state map, not a claim of universal transitive closure:

- **Module/index state:** registrars mutate types, imports, functions, globals, tables, elements, exports and stable-function ordinal mappings. Body builders read their handles. Reserve first, bind once, fill once; never mix stable handles with positional indices.
- **Type registries:** Promise/vector/value/frame registration writes struct, reverse-name, field and array maps. Frame conversion and thenable dispatch read them.
- **Scheduler caches:** `asyncScheduler`, Promise-all/delay caches and the prepared-drive WeakMap are written during reservation and read during lowering/publication. Replace them with one transaction-owned reservation result, not parallel authorities.
- **Function emission state:** frame lowering mutates locals/local maps/body buffers and temporarily changes `currentFunc`; the shared engine tracks detached `liveBodies`. Detached builders must preserve ordering and instruction-array ownership without exposing legacy context.
- **ABI registries:** vector support and callable providers use `programAbiSession`, type/provider registries and export planning. Supply explicit bound handles and support identities instead.
- **Finalizer inputs:** thenable fills read complete method/field/accessor/object/closure inventories. These cannot be replaced with an empty inventory merely because a particular fixture passes.
- **Policy/publication:** target/native-string/value policy, optional Promise hooks, exception handling, timer dispatch and boundary exports must be resolved explicitly before emission.

`coerceType`, `addUnionImportsViaRegistry`, `ensureAsyncDriveRuntime`, `prepareIrVectorSupport` and the full frame engine are **not presently drop-in source-free utilities**. Their narrow-looking signatures conceal allocating delegates or broader context dependencies.

## 5. Proposed implementation sequence and ownership

### Shared prerequisite: physical reservation contract

Proposed owner: `src/wasm/physical/module-reservations.ts`.

A module-owned transaction should provide explicit type/import/global/tag/table/function reservation, typed lookup, body completion and sealing. It must reject duplicate/missing fills and post-seal allocation. No `CodegenContext`, frontend callback or arbitrary resource-discovery callback.

Backend resource plans should distinguish:

1. Program ABI bindings.
2. Owner-derived support bindings.
3. Shared native-runtime resources.
4. Explicit platform/publication resources.

### Low A: native runtime resource implementation

Canonical destinations:

- `src/runtime/wasmgc/promise/` — settlement, reactions, adoption and their resource contracts.
- `src/runtime/wasmgc/values/` — required numeric/undefined support.
- `src/runtime/platform/standalone/` — timer capability/publication binding.

Source donors include `async-scheduler.ts`, `native-promise-number-boundary.ts`, `any-helpers.ts`, `ir-native-promise-delay.ts` and their identified settlement/finalization dependencies. Preserve existing legacy entry points as downward adapters.

This lane must implement reservation **and completed bodies**, not merely move schemas. Thenable/object/closure dependencies require their own explicit prerequisites; they are not automatically authorized wholesale by this map.

### Low B: prepared async backend adapter

Canonical destinations:

- `src/backend/wasmgc/resources/native-async.ts`
- `src/backend/wasmgc/async/frame.ts`
- `src/runtime/wasmgc/async/frame-engine.ts`

Separate `ir-async-frame.ts`’s IR/value/layout work from the shared engine. The runtime engine should consume closed state/transition data and bound Wasm resources—not `AsyncCfgPlan` callbacks carrying legacy context.

Preserve state order, live-spill restoration, updates, always-async delivery, rejection behavior and the selected **post-pass runtime bodies**. Existing unsupported handlers/instructions remain explicit; do not narrow the semantic schema.

B can prepare the adapter and resource census in parallel; composed execution waits for A’s frozen resource interface.

### Parent transaction integration

Existing change sites:

- `program-runtime-abi.ts` and `runtime/callable-declarations.ts`: missing callable contracts.
- `program-physical-plan.ts`: complete demand/resource plan and located capability failures.
- `program-consumer.ts`: native async dispatch, resource binding, support ownership and exact completion census.
- `ir/integration.ts` and legacy adapters: real public callers of the same canonical implementation.

Keep mixed whole-program validation outside newly clean backend roots until its remaining closure is resolved.

**Earliest useful executable checkpoint:** the existing source-produced delay → suspending numeric owner through whole-program prepare/accept/emit, including 70/3e9 transport and canonical void completion. This requires real runtime resources, not fabricated IR or test-only callers. The complete Promise.all/vector/string/main family remains the subsequent mandatory cutover denominator; this first increment must not be described as full-family acceptance.

## 6. Required proof

Reuse the existing native delay/family suites, codec/replay harness and A’s source-receipt/admission helpers:

- Actual JS source → typed preparation → serialization/replay → whole-program acceptance → instantiated emitted bytes.
- Exact Promise ABI, manifest/provider order, support identities, imports/tables/globals/exports, binary/WAT and observable timer/value traces.
- Missing resource, unfinished placeholder, duplicate fill, wrong signature, stale attachment, absent runtime-state dependency and post-seal allocation negatives.
- Source-produced post-pass body changes authenticated without cloning manifest/provider authority.
- Native suspension, 3e9 bridge, reverse-order Promise.all, rejection, timer failures and main undefined completion retained.
- Fresh-process backend/runtime admission rejects frontend, legacy facades and registered-direct delegates.
- Existing public **14/14** remains a preservation requirement, not proof that the new whole-program route executed.

No refusal should disappear until its complete resource obligation is implemented and witnessed. Host/linear behavior, P/C evidence, ABI30’s unresolved witness, remaining native materialization and eventual public IR-only default cutover remain intact.
