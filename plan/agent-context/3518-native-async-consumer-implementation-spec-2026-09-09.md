# Next checkpoint: complete native async-family emission through the prepared consumer

Source pin: `428e5b4b2e7645593681a998df42f5d769c53300`, inspected read-only in `/private/tmp/js2-3518-native-string-value-consumer-20260909`.

The checkpoint should implement the complete five-owner family through `acceptPreparedIrProgram → emitAcceptedIrProgram`. It must include the runtime resources needed by `main`, not stop at frame helpers or successful preparation.

This is a multi-lane, dependency-ordered checkpoint. Two small extraction lanes alone cannot complete it: native invocation/property support and number formatting remain substantive dependencies.

## 1. Current boundary and prerequisite composition

Verified current facts:

- [program-physical-plan.ts:741](/private/tmp/js2-3518-native-string-value-consumer-20260909/src/ir/program-physical-plan.ts:741) still rejects async bodies.
- [program-consumer.ts:524](/private/tmp/js2-3518-native-string-value-consumer-20260909/src/ir/program-consumer.ts:524) reserves vectors/string-values and lowers every selected function through ordinary lowering. It has no async dispatch.
- The six canonical callable declarations already exist in [native-async-callables.ts:42](/private/tmp/js2-3518-native-string-value-consumer-20260909/src/ir/runtime/native-async-callables.ts:42). Reuse them unchanged.
- Queue, settlement, resolution, captured-then lookup, delay/combinator bodies, frame dispatch and await classification have canonical executable owners.
- **This checkout does not contain `native-closures.ts` or `native-argument-vectors.ts`.** Its `native-promises.ts` still accepts raw closure-root/metadata tokens. Compose the reviewed sibling packs and issued-closure-pack Promise join explicitly; do not reconstruct them locally.
- Native errors and primitive/string-number resources are present.
- The vector-emitter refinement is a separate prerequisite. Preserve the original failing baseline receipt and use the repaired-baseline/candidate comparison already approved.
- The public compiler still calls `generateModule`; `runIrProgramDriver` is an internal transaction, not evidence of public cutover.

Population contract:

- Original source: five terminal owners, including four async functions and synchronous `delay`; five lexical awaits.
- Existing preparation assertions require **5 functions/22 calls → 16 functions/33 calls after async preparation → 16/33 after optimization**, with independent validation recollection.
- Keep those populations separate from newly materialized runtime functions and the **three frame helpers per async owner**.
- I inspected the current assertions, not a newly executed recount. The next acceptance receipts must perform that recount again.

## 2. Shared acceptance contract

Add a pure, source-free plan in:

- `src/ir/program/native-async-requirements.ts`
- `tests/issue-3518-native-async-requirements.test.ts`

Proposed exported operations:

```ts
deriveNativeAsyncRequirements(input): NativeAsyncRequirements
assertNativeAsyncRequirementsCurrent(input, requirements): void
```

`input` must explicitly contain the complete semantic functions, selected prepared functions, derived records, ABI declarations, selected manifest/policy, allocation information and resolved runtime configuration. Whole-program authentication remains in the checked parent boundary before calling the pure derivation.

The returned plan must contain:

- Ordered semantic and selected-owner censuses, including empty owners.
- Each call occurrence’s owner, region, ordinal and canonical binding key.
- Every async owner’s exact entry binding, selected attachment and state IDs.
- Parameter/value/spill mappings, incoming restoration sets, updates and terminators.
- Complete handler data, even where the current backend must reject unsupported handler forms.
- Exact vector-layout associations and conversion references.
- Native callable/provider demands and required object/closure/value/service resources.
- Owner-qualified symbolic frame/helper identities.
- An explicit unavailable result for any missing dependency—not a smaller successful plan.

Authenticate each selected attachment against **its own selected semantic plan**, as the existing Promise planner does. Do not substitute the semantic program’s equal-looking plan object.

Re-derive and compare before emission. Decoding must reauthenticate a new valid program/projection; an issued resource plan from the original program cannot authorize the decoded program.

### Preallocation ABI

Extend the existing symbolic declaration/recipe mechanism, not a second allocator or ABI map.

Before creating the physical module:

1. Authenticate the program, selected projection and all resource requirements.
2. Obtain complete producer declarations and ordered reservation steps.
3. Match existing callable entries by canonical reference, intent, signature and provider contract.
4. Add owner-qualified supplemental frame/runtime entries.
5. Seal **one `ProgramAbiMap`** containing semantic and supplemental entries.

Use the existing binding/order factories. Do not parse encoded IDs or infer provider permission from names.

The clock remains the authenticated positive-zero projection with **no physical function slot**. Preserve the logical/physical distinctions for:

- Delay’s Promise result versus its physical `externref`.
- Promise.all’s nullable vector parameter.
- Number formatting’s logical string result and native carrier.
- Console’s zero-result signature.
- Concat’s canonical arity/provider contract.

The fixed ABI30 `planningSealed` witness remains unresolved; this work does not satisfy it.

## 3. Disjoint implementation lanes

All paths below are proposed ownership, not acquired claims.

### Lane A — prepared frame planner and executable adapter

Writes:

- `src/ir/program/native-async-requirements.ts`
- `src/backend/wasmgc/async/prepared-frame.ts`
- `src/backend/wasmgc/resources/native-async-frames.ts`
- `src/runtime/wasmgc/async/frame-entry.ts`
- `tests/issue-3518-native-async-requirements.test.ts`
- `tests/issue-3518-native-prepared-frame.test.ts`

Read-only donors:

- `codegen/ir-async-frame.ts`
- `codegen/async-frame.ts`
- Existing canonical `frame-engine.ts` and `native-await.ts`.

Freeze these responsibilities:

- `reserveNativeAsyncFrames(tx, requirements, dependencies)` reserves each owner’s frame type, resume, fulfill-step and reject-step.
- `emitPreparedNativeAsyncFrame(...)` returns detached entry/resume/fulfill/reject bodies and locals tied to those exact reservations.
- `fillNativeAsyncFrames(...)` installs every output once.
- Existing canonical step, dispatch and await builders remain the executable owners; do not duplicate them.

Frame layout must preserve:

- Fixed `state`, `sent`, `mode`, `abrupt`, `error` fields.
- Ordered immutable parameters.
- Ordered mutable spills, **excluding parameter IDs**.
- Final native Promise result field.
- Exact incoming live-spill restoration, update order and transition targets.

The adapter must emit `asyncRuntime.states[i].body`, not stale `asyncPlan.states[i].body`. The latter still supplies semantic updates/terminators.

Entry behavior remains: create pending Promise → initialize frame → call initial resume once → return that Promise. Every native await remains asynchronous, including already-settled Promises and plain values.

Use a transaction-local typed local allocator, not `CodegenContext`, `FunctionContext`, arbitrary callbacks or a renamed legacy context. Preserve logical nullability separately from defaultable scratch storage; any refinement must be justified by construction/control flow. The newly discovered vector bug is a required counterexample here.

For handler forms not yet admitted by the existing prepared adapter, preserve their schema and return a located refusal before allocation. Do not silently erase handlers or claim general try/finally support from the handler-free family.

### Lane B — delay and Promise.all resource join

Writes:

- `src/backend/wasmgc/resources/native-delay-combinator.ts`
- `src/backend/wasmgc/resources/native-timer-publication.ts`
- `tests/issue-3518-native-delay-combinator-resources.test.ts`
- `tests/issue-3518-native-timer-publication.test.ts`

Consumes, without re-extraction:

- `runtime/wasmgc/promise/delay-bodies.ts`
- `runtime/wasmgc/promise/combinator-bodies.ts`
- The issued Promise, closure, value and shared-vector packs.

Reserve/fill must include the real delay capture, timer callback, provider function, combinator state/element capture, subscription and all fulfillment/rejection reactions.

Important donor invariants:

- Delay capture fields 3/4 are Promise/value.
- Callback resolves through **resolveValue**, not direct fulfillment.
- Timer registration failures reject according to the current tagged/foreign-exception distinction.
- Promise.all iterates logical length, preserves input/result order and normalizes through real resolveValue.
- Empty aggregate timing and pending-versus-settled distinctions remain unchanged.
- Race/other combinator compatibility remains outside this new provider’s admission, but existing shared code is not altered or deleted.

Timer publication is not merely a callback body. Reproduce the existing production contract: dispatcher, binding table, marker table, element entry, manifest global and collision-safe aliases, using ledger-owned objects.

Reuse `timer-capability-contract.ts` constants and the existing runtime timer bridge. An explicit timer service is permitted; JS-host Promise semantics are not.

### Lane C1 — native property/classifier dependency closure

Writes, staged under one owner:

- `src/backend/wasmgc/resources/native-object-access.ts`
- `src/runtime/wasmgc/values/object-access-bodies.ts`
- `src/runtime/wasmgc/values/accessor-bodies.ts`
- `src/codegen/object-runtime.ts`
- `src/codegen/accessor-driver.ts`
- Focused object-access ownership/execution tests.

This is a genuine blocker, not an optional enhancement. Current `fillNativePromiseResources` requires:

- AnyValue layout.
- Open-object type/getter.
- Accessor getter.
- Exact method/accessor/field/closure carrier inventory.
- Property lookup/callability dependencies.

Extract the actual dependency-closed read/lookup bodies and their prerequisites. Do not import `ensureObjectRuntime` wholesale.

The materializer must reconcile:

1. Complete prepared allocation/type/callable population.
2. Compiler-created carriers from **every resource recipe**.
3. Actual owned resource tokens.

Only that combined census may establish an empty category. “The fixture has no object literal,” missing registry entries or a valid-looking classifier signature cannot establish absence.

The property getter must preserve descriptor/prototype ordering, original receiver and exception propagation. The captured-then repair remains mandatory: the queued job invokes the captured callable, not a second property read.

This lane needs a frozen transitive donor list before edits because `object-runtime.ts` is large and its lookup dependencies are not limited to its exported getter.

### Lane C2 — closure invocation and Promise fill

Starts after C1’s resource API freezes; no simultaneous writes to `object-runtime.ts`.

Writes:

- `src/backend/wasmgc/resources/native-invocation.ts`
- `src/runtime/wasmgc/values/closure-invocation-bodies.ts`
- `src/codegen/object-runtime.ts` — only invocation donor adaptation.
- `src/codegen/closure-exports.ts` — invocation donor adaptation.
- `src/codegen/closure-props.ts`
- Invocation/Promise-fill tests.

Required real bindings include:

- ObjVec new/push, using the existing pack and early shared backing-array adoption.
- `applyClosure`, method dispatch and arity handling.
- Carrier-bag presence, extern property access and callable classification.
- Then dispatch, accessor invocation, canonical undefined and TypeError.
- All closure shapes created by Promise settlement, delay callbacks and source/runtime support.

Do not replace missing dispatchers with null/undefined-returning bodies. Existing legacy fallback behavior stays in compatibility adapters; it is not proof that the new pack has complete bindings.

Integrate the reviewed Promise/closure join unchanged: issued closure pack plus metadata request ID, exact signature membership, root identity and public metadata length. Promise owns its settlement capture and trampolines; no duplicate capture or second closure authority.

### Lane D — complete native number formatting

Writes must be split into two dependent substeps:

**D1: source-to-prepared builtin boundary**

- New frontend-owned native formatter preparation module.
- Pure formatter-support contract under `ir/program`.
- Narrow extraction of the build-only portion of `codegen/stdlib-selfhost.ts`.
- `stdlib/number-format.ts` import/type boundary repair.
- Producer/replay tests.

**D2: physical formatter**

- `runtime/wasmgc/values/number-format-bodies.ts`
- `runtime/wasmgc/values/number-ryu-bodies.ts`
- `backend/wasmgc/resources/native-number-format.ts`
- Narrow adapters in `codegen/number-format-native.ts`, `number-format-selfhost.ts`, `number-ryu.ts`.
- Body/declaration/execution preservation tests.

This dependency cannot be omitted: `emitToString` requires the self-hosted radix implementation and Ryū, not merely an integer formatting loop.

D1 must settle and test the portable scratch-buffer contract before D2 starts. The current self-hosted definition carries a concrete array type through `bufRef`; a fake index, erased type, backend AST parse or invocation of the legacy compiler is not acceptable.

Preserve the original `numToStringRadixDef` source as the algorithm authority. Preparation must transport its fully typed support body and complete callee/literal dependencies. If that requires an additive prepared-support contract, obtain the P release below first.

Resolve `JS2WASM_NUMBER_TO_STRING_INTEGER_FASTPATH` in the historical wrapper/options boundary. The canonical builder receives a boolean; it must not reread ambient environment state.

No formatter lane completion claim until full values—including 3e9, fractional values, −0, NaN and infinities—execute through the real consumer.

### Lane E — native concat, stdout and observable runtime publication

Writes:

- `src/runtime/wasmgc/values/string-concat-bodies.ts`
- `src/runtime/wasmgc/values/stdout-bodies.ts`
- `src/backend/wasmgc/resources/native-string-output.ts`
- Narrow donor adapters in `codegen/native-batched-concat.ts` and `codegen/native-strings.ts`.
- Concat/stdout/publication tests.

Preserve the real flat/rope concat threshold, operand order, UTF handling, null-carrier conversion and four newline joins already present in prepared `main`.

`__stdout_append` owns a nullable accumulator and calls real concat; console’s logical void result must stay void. Include the genuine stdout readout and Promise/value/vector observation boundaries needed by the existing runtime, rather than test-only fabricated inspectors.

Coordinate `closure-exports.ts` edits with Lane C2 and Lane B’s publication adaptation; it cannot have concurrent writers.

## 4. Parent integration scope and lifecycle

Parent exclusively owns:

- `src/ir/program-physical-plan.ts`
- `src/ir/program-consumer.ts`
- New `src/backend/wasmgc/program/native-async-program.ts`
- Supplemental ABI integration.
- Boundary policy/history, consumer acceptance tests and replay harness.

No worker independently edits these join files.

The aggregate consumes authenticated plans and issued packs. It must implement:

1. **Preflight:** complete owner/provider/type/closure/object/service census and every dependency present.
2. **Plan:** complete symbolic declarations, signatures and publication obligations; one ABI plan sealed before allocation.
3. **Reserve:** shared vector/string types once; imports/tag; native values/errors/closures/ObjVec; Promise queue/carriers/settlement; delay/combinators; frame resources; formatter/output; startup/publication resources.
4. **Reconcile:** every actual token/object against its producer declaration and owner. Preserve the declared reservation schedule, including interleaved signature/type registration—not merely final counts.
5. **Freeze once:** no new slots/imports/types afterward.
6. **Bind:** actual final indices to the same ABI; finish binding once.
7. **Fill:** dependency bodies, selected prepared bodies, four outputs per async owner, startup and publication. Use stable handles for calls and final indices only in their proper spaces.
8. **Seal:** complete ledger/body/reference/publication census and exact function ownership before returning an emitted result.

Recursive helper dependencies are handled by reservation before fill, not placeholder implementations.

Only a completely planned native async owner bypasses the existing async refusal. Other owners retain located gaps. Do not exempt an entire runtime-callable category or skip selected-state validation.

The emitted function census must distinguish:

- All 16 prepared functions.
- Frame machinery.
- Native providers and support functions.
- Startup/publication helpers.

No resource helper may replace a missing prepared function in the denominator.

## 5. P/C reconciliation required before overlapping writes

Fresh read-only inspection confirmed P’s twelve recorded file hashes unchanged.

C’s five hashes also match the preserved snapshot. Correction to historical path shorthand: its materializer is:

`src/codegen/prepared-async-resource-materializer.ts`

The C materializer has its own `ResourceCensus`/callback domain; **do not import that as a second authority alongside the current ledger**. Its host-only frame/helper validation is useful design evidence, not a native implementation to merge wholesale.

Required explicit releases:

- **C:** extend the earlier string/value-only release to native async planning, frame materialization, helper accounting and consumer dispatch in a different worktree. Preserve all five e042 files byte-for-byte.
- **P:** authorize any additive prepared runtime-support declaration/validation/transport work required by D1 and async resource associations. Name exact affected current paths before dispatch. Earlier source-option forwarding permission does not authorize async ABI or codec changes.

Prefer the current supplemental preallocation-ABI mechanism for physical frame/helper declarations. Do not import P’s host-oriented schema-v2 draft merely to obtain native acceptance.

No P/C release is inferred from this specification. Parent verifies live claims and records the exact scope agreement.

### Recorded C release after specification

C explicitly released native async requirements, prepared-frame adaptation,
frame-entry/resource materialization at the new paths above, and parent-owned
planning/helper accounting/ABI integration/dispatch in program-physical-plan,
program-consumer and native-async-program, in a different worktree. The canonical
single-ledger implementation is permitted; importing the paused host draft's
ResourceCensus, overwriting e042, or changing P's ABI/schema/codec is excluded.
Other donor ownership must still be coordinated independently.

C verified paused HEAD `9feb7bf8fc0f8fddccf87235c7664651eb338e92` and unchanged
SHA256 values: consumer `3e42b6d483cc03530fdae952cd5528d1840eb15d4c34e62af186d8efd5e08ca9`,
physical plan `4fc9131078f4d460e371af3a46069bafa52f96c151574b1ee13b3ec774ad6046`,
async physical `77d60963609332b982374c048b0036b716165b45d7404025ca887a525dc128a4`,
materializer `ffa12ca3e1c31423f204b8e6256403139b387980f405da6f7a35971aed666041`,
async test `310f53edb55c0839bcb604872af7d2be84fc47e1ff9e578f4b5abae4012fdbc3`.
No paused source was changed or validated for this release.

## 6. Mandatory end-to-end acceptance

Use the unchanged playground source and the existing exported runtime variant. Prepare original and decoded inputs, then call the **actual prepared consumer**.

Required behaviors:

- Delay/fetch suspends and yields 70.
- Non-i31 result 3e9 survives the real value boundary.
- Sequential requests start only after the preceding timer fires.
- Promise.all starts eagerly, accepts reverse completion and retains input order.
- Empty sequential/parallel cases preserve their distinct immediate/microtask timing.
- Later sequential registration failure prevents iteration three.
- Parallel registration failure rejects while retaining the existing eager-start behavior.
- `main` prints the exact four newline-terminated lines, transitions sequentially then in parallel, and fulfills once with canonical undefined—not null.

The internal undefined tag and public dynamic-boundary tag are different contracts; test both correctly.

Also require:

- Recount 5/22 and 16/33 at the established stages; retain every support/derived owner.
- Actual binary validation, execution, module imports, runtime publication and typed ABI indices.
- Original/prepared-codec replay, GVN off/on, fresh instances and fresh processes.
- Fresh backend replay forbidding frontend/codegen loads.
- Exact missing/foreign/copied/stale pack, owner, provider, layout, declaration, call and state-transition negatives.
- Failure before allocation where preflight can detect it; accepted-token single use on subsequent failures.
- Captured-then, poisoned getter, self-resolution, queue FIFO/growth and closure argument semantics.
- Existing synchronous/no-demand preservation against the **repaired vector baseline**, retaining the unrepaired CompileError separately.

Preserve existing body-receipt denominators, methods/initializers, canonical export identities and six/ten/twelve gate obligations. Moves require additive destination coverage; no reseeded hashes, reduced populations or widened allowed edges.

## Dispatch order

After prerequisite composition and scope releases:

- Start **A, B and D1** independently.
- Start **C1** with its explicit dependency-closed donor map.
- **C2** follows C1; **D2** follows D1.
- **E** can proceed independently, serializing its shared donor-file edits.
- Parent assembles the aggregate progressively, but removes the async refusal only when the complete dependency plan is available.

This advances actual prepared-program execution. It does **not** complete standalone public dispatch, ordinary vector source admission, arbitrary async forms, ABI30 proof, full folder closure or direct-codegen retirement. No tests or writes were performed for this specification.
