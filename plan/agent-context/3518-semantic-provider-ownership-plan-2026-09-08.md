# Next checkpoint: executable semantic verification and provider ownership

Source pin: `8b85772c6b9a0662098934022c467b863331d378`, in `/private/tmp/js2-3518-ownership-integration-20260908`. This specification is based on source inspection and lightweight AST census, not executed tests.

The next coherent checkpoint is to separate:

- Async-plan construction/verification and intrinsic signature/effect verification into clean semantic owners.
- Capability catalogs, provider selection, manifest construction, and authenticated async attachments into clean IR-runtime owners.

This removes executable dependency chains currently preventing preparation separation. It does **not** move the whole mixed `verify.ts`, claim complete preparation closure, or implement missing native materialization.

## 1. Boundary decisions and shared interfaces

### Semantic ownership

Use these canonical destinations:

- `src/ir/core/intrinsic-contracts.ts`: signature, source location, intrinsic-use and diagnostic data.
- `src/ir/core/intrinsics.ts`: the existing single intrinsic-definition table, signature constants and ID guard.
- `src/ir/core/callable-bindings.ts`: structural callable-reference construction and equality.
- `src/ir/core/async-intents.ts`: existing vocabulary plus its existing membership SET and `isAsyncRuntimeFeature`.
- `src/ir/analysis/effects.ts`: existing effect authority.
- `src/ir/analysis/intrinsics.ts`: effect evidence, semantic-use verification and instruction-signature verification.
- `src/ir/analysis/async-plan.ts`: semantic plan validation, canonicalization, construction, serialization and hashing.

The async executable owner belongs in **analysis**, not core: its constructors call the validator. Core’s existing plan schema remains independent of analysis and runtime.

### Resolve `IntrinsicDefinition.feature` without duplicating or weakening catalogs

The current table’s every row uses `feature === id`; its private `definition` helper receives no explicit third argument. Conversely, the runtime vocabulary deliberately includes provider-only `math.reduce-trig`.

Use this exact split:

1. Core owns the complete row schema as `IntrinsicDefinition<Feature extends string>`, with mandatory `id`, `signature` and `feature` fields.
2. The **one existing table** moves to core and uses `IntrinsicDefinition<IntrinsicId>`. Its initializer, row order, objects and signatures remain unchanged.
3. `src/ir/runtime/contracts/intrinsics.ts` retains the complete existing runtime-feature tuples/unions, including `math.reduce-trig`, and exposes its existing `IntrinsicDefinition` name specialized with that full `RuntimeFeature`.
4. The old `src/ir/intrinsics.ts` preserves its existing wider exported table type through a typed alias to the **same canonical object**. No table reconstruction, projection, cast to `unknown`, or provider-vocabulary narrowing.

The semantic contracts moved out of runtime are exactly:

`IntrinsicSignature`, `IntrinsicSourceLocation`, `IntrinsicUse`, the parameterized row schema, `IntrinsicVerificationCode`, and `IntrinsicVerificationFailure`.

Keep runtime-feature tuples, their aliases, `PURE_MATH_HOST_CAPABILITIES` and `HostCapability` in their current runtime contract owner.

### Frozen verification interface

Add:

```ts
verifyIrIntrinsicSignature(
  instr: IrInstrIntrinsic,
  typeOf: ReadonlyMap<IrValueId, IrType>,
): readonly string[]
```

This is the exact semantic prefix of the current combined function: version, argument count, argument types, result type—in that order.

Preserve `verifyIntrinsicUse` and `IntrinsicEffectEvidence` signatures. Keep the evidence class, private field, constructor, static constructor, `isPure`, freeze and `instanceof` authority together.

Runtime owns the existing public signature:

```ts
verifyIrIntrinsicInstruction(
  instr: IrInstrIntrinsic,
  typeOf: ReadonlyMap<IrValueId, IrType>,
): readonly string[]
```

It first obtains semantic diagnostics, then executes the original provider-check suffix. No arbitrary callbacks, injected provider authority, or reordered diagnostics.

## 2. Disjoint worker write maps

Paths below are repository-relative to the pinned checkout. New paths are proposed; existing paths are modifications.

### A — semantic implementation ownership

Production writes, exactly eleven:

```text
NEW src/ir/core/intrinsic-contracts.ts
NEW src/ir/core/intrinsics.ts
NEW src/ir/core/callable-bindings.ts
NEW src/ir/analysis/effects.ts
NEW src/ir/analysis/intrinsics.ts
NEW src/ir/analysis/async-plan.ts

    src/ir/core/async-intents.ts
    src/ir/runtime/contracts/intrinsics.ts
    src/ir/intrinsics.ts
    src/ir/effects.ts
    src/ir/callable-bindings.ts
```

New focused test:

```text
tests/issue-3518-semantic-verification-ownership.test.ts
```

Exact movement:

- All existing callable-binding implementation: 17 declarations, 15 top-level functions. Import identities directly from canonical shared contracts/identity implementation and nodes directly from core.
- All effects implementation: seven declarations, five top-level functions.
- Intrinsic constants/table/ID guard to core; evidence class and semantic verification to analysis.
- `ASYNC_RUNTIME_FEATURE_SET` and `isAsyncRuntimeFeature` move together from old async providers into existing core async intents.
- The **28 semantic functions** from `async-plan.ts`, with their supporting types/constants and `IrAsyncPlanInvariantError`, move together:

```text
asAsyncStateId, asAsyncHandlerId, canonicalPromiseAbi,
isNonNegativeSafeInteger, compareNumber, sameValueSet, describeValues,
terminatorUses, stateUpdates, updateMap, stateEdges, stateLiveness,
addPurityError, verifyPureData, addError,
verifyResumeIncomingEdges, verifySpillUpdates, verifyCanonicalPromiseAbi,
irAsyncPlanNeedsNumberBridge, requiredRuntimeIntents,
verifyIrAsyncPlan, assertIrAsyncPlan,
clonePlanData, canonicalPlanInput, createIrAsyncPlan,
canonicalJson, serializeIrAsyncPlan, hashIrAsyncPlan
```

Also retain the exact invariant-code/error schemas, `StateLiveness`, `StateEdge`, `AsyncValueChecker`, and ordering authorities `runtimeIntentOrder`/`runtimeIntentRank`.

A **does not edit old `async-plan.ts` or old async providers**; B owns their final compatibility forwarding.

### B — provider and authenticated attachment ownership

Production writes, exactly twelve:

```text
NEW src/ir/runtime/host-capabilities.ts
NEW src/ir/runtime/async-providers.ts
NEW src/ir/runtime/callable-declarations.ts
NEW src/ir/runtime/manifest.ts
NEW src/ir/runtime/async-attachment.ts
NEW src/ir/runtime/intrinsic-verification.ts

    src/ir/runtime-host-capabilities.ts
    src/ir/async-runtime-providers.ts
    src/ir/runtime-callable-declarations.ts
    src/ir/runtime-manifest.ts
    src/ir/async-plan.ts
    src/ir/intrinsic-support.ts
```

New focused test:

```text
tests/issue-3518-provider-verification-ownership.test.ts
```

Exact movement:

- Entire host-capability implementation: 48 declarations, 28 top-level functions. Move the catalog, canonical-record identity SET, lookup maps, factories, guards and resolvers together. Schema remains at its existing runtime-contract path.
- Entire remaining async-provider implementation, except A’s semantic SET/guard. Preserve derived catalog objects, async-ID filtering and narrowed callable value types.
- Entire runtime-callable-declaration implementation: five declarations, two top-level functions. Its ReferenceError declaration still derives from the central capability record.
- Entire manifest implementation: 85 declarations, 38 top-level functions, both classes and all initializers. This includes `projectRuntimeBackendRequirements`, all provider tables, `stringConcatManyArityCap`, graph algorithms and `RuntimeManifestBuilder`.
- Exactly these **11 runtime functions** from old async-plan:

```text
runtimeAttachmentError, sameOrderedStrings, expectedAsyncProviders,
assertFrozenProvider, freezePreparedIrAsyncStateBody,
isPreparedIrAsyncStateBodyFrozen, sealPreparedIrAsyncStates,
assertPreparedIrAsyncRuntimeCurrent, createPreparedIrAsyncRuntime,
sealPreparedIrAsyncRuntimeContainers,
preparedIrAsyncFrameCapabilityFailure
```

Move the **single** `preparedManifestByPlan` WeakMap with them.

- From intrinsic support, move `BACKEND_COMPOSITE_BY_INTRINSIC`, `callableBindingKey`, `ADMITTED_CALLABLE_TARGETS` and the combined verification function. The admitted-target table remains derived once from canonical provider/catalog authorities.
- Keep the remaining intrinsic-support preparation implementation and `IrRuntimeFunctionPreparationError` where they are. Retarget their imports to the canonical implementations; do not move that mixed file wholesale.

Old paths forward existing exports explicitly. Do not introduce wrapper classes, duplicate private state, broader exports or re-created catalog objects.

### Parallel-start prerequisite

The lanes can implement concurrently after the coordinator freezes the paths and interfaces above.

B can independently relocate capability/catalog/manifest bodies while A implements semantic owners. B’s composed typecheck/runtime validation waits for A’s frozen canonical exports. Neither worker invents temporary stubs or edits the other’s facade.

## 3. Parent integration and real consumers

Parent owns these four production import integrations:

```text
src/ir/verify.ts
src/ir/async-prepare-ir.ts
src/ir/runtime-program-manifest.ts
src/ir/program-middleend-ir.ts
```

Limit them to explicit canonical import changes; retain function bodies and existing prepared-function types.

Actual production connections are:

- [Async preparation](../../src/ir/async-prepare-ir.ts#L254) constructs plans through `createIrAsyncPlan`, including the other existing construction sites at 539 and 862.
- [Function verification](../../src/ir/verify.ts#L383) invokes semantic async verification; its instruction verifier invokes combined intrinsic verification.
- [Runtime preparation](../../src/ir/intrinsic-support.ts#L965) constructs `RuntimeManifestBuilder`, requests features, adds intrinsic uses, freezes, resolves providers and creates authenticated async attachments.
- [Program runtime validation](../../src/ir/runtime-program-manifest.ts#L196) authenticates those exact attachments.
- [Middle-end validation](../../src/ir/program-middleend-ir.ts#L60) still invokes the combined function verifier with explicit verification controls. Its concat-arity query switches to canonical runtime manifest ownership.

Whole-program wrappers remain program-layer work. Do not move them into `ir/runtime`: runtime→program remains forbidden.

## 4. Semantics and lifecycle that must remain exact

### Diagnostic ordering

Preserve the current intrinsic order:

1. Version.
2. Argument count.
3. Argument types.
4. Result type.
5. Callable-provider identity.
6. Backend-composite operation.

Preserve missing-type handling, argument-loop bounds, messages, diagnostic multiplicity and thrown errors. In particular, do not opportunistically change malformed-ID behavior while extracting the prefix.

Do not reorder the surrounding `verifyIrFunction` diagnostics. Its current runtime-sensitive paths remain intact:

- Missing plan/runtime and adapter checks.
- Counted-string provenance traversal: blocks, semantic async states, prepared runtime states, using one visited set.
- Definition collection in that same order, including existing overwrite behavior.
- Interleaved `string.repeat` semantic/provider checks.
- Existing options/default handling.

The prepared runtime traversal in `inline-small.ts` and `monomorphize.ts` remains untouched. No conversion of their signatures to semantic-only functions.

### Runtime authority

Preserve:

- One central capability catalog and canonical identity SET.
- Provider catalog initialization order and derived async/admission tables.
- Builder policy-default resolution, provider cloning, graph ordering and open/building/frozen/failed transitions.
- Original error classes, names, fields and identities.
- Exact ordered provider-object identities selected from the frozen manifest.
- Exact backend-requirement projection and rejection of mixed host/native projection.
- In-place state-body freezing and copy-on-write container sealing, including unchanged-object return paths and `typeLayouts` identities.
- WeakMap rollback: failed first attachment removes its provisional association; failure with an existing binding does not erase that binding; a different manifest for an already-bound plan still fails before replacement.

Moving preserved host catalog/validation code is not authorization for new host implementation.

## 5. Preservation receipts and mandatory boundaries

Parent owns receipt/policy integration and new boundary/replay controls.

Reuse:

```text
scripts/compiler-boundaries.json
tests/issue-3518-runtime-data-contract-seam.test.ts
tests/issue-3518-program-data-contract-boundary.test.ts
tests/issue-3518-capability-schema-seam.test.ts
tests/helpers/typed-program-source-free.mjs
tests/issue-3518-typed-program-source-free.test.ts
```

The coordinator verified that the capability receipt exists at the exact path above; the capability declarations’ existing receipt must not be bypassed.

### Historical denominator remains unchanged

Reconstruct the existing runtime-data ledger at its original source ordinals:

```text
async-runtime-providers   26 declarations / 12 top-level function declarations
runtime-manifest         85 / 38
intrinsics               24 / 5
async-plan               48 / 39
intrinsic-support        41 / 24
TOTAL                   224 / 118
```

These counts include overload declarations; they are **not** nested function-body counts. Preserve all pinned hashes and the previous 135 moved-declaration ledger.

Required narrow adapters:

- Reconstruct async providers across runtime ownership plus the moved semantic SET/guard.
- Reconstruct async-plan across its semantic and runtime destinations.
- Reconstruct intrinsic support’s original verifier from its exact semantic prefix and provider suffix; independently pin the new composition so replacing it with an empty successful adapter fails.
- For the intrinsic row schema/catalog type split, normalize only the explicitly approved type specialization. Preserve initializer/body text, documentation and public compatibility types.
- Preserve all other original declarations without normalization.

Supplement—not replace—this with method/initializer receipts:

- Async invariant class: constructor, including parameter-property behavior.
- Intrinsic evidence: all four members.
- Manifest invariant class: three members, including two initialized fields.
- Manifest builder: **35 members**, comprising 13 fields, nine field initializers, constructor, getter, 16 method bodies and four additional overload declarations.
- Existing callback/IIFE bodies and catalog initialization order.

The independent AST census also found async-plan 87, async providers 15, intrinsics eight, intrinsic support 52, verify 69, effects eight and manifest 105 function-like bodies. Keep this supplemental metric separate from the historical ledger.

Missing, renamed, duplicated or changed bodies must fail. Class visitation is not public-caller evidence; distinguish production-invoked members from test/integration-only or unproved members.

### Boundary activation

Activate all twelve new canonical modules with fixed mandatory paths. Preserve all existing active roots, historical populations and allowed edges; this design needs **no allowed-edge amendment**.

Test runtime and type-only imports, exports/barrels, import types/type queries and aliases. Reject old facades, frontend/compiler/backend/physical dependencies and unresolved dependencies from canonical roots. Analysis→runtime remains forbidden.

Test individual deletion, grouped deletion and activation demotion. Do not regenerate an expected population from surviving files.

Preserve existing six/ten/twelve evidence groups and strict unknowns unchanged. Do not repurpose declaration closure as ABI caller proof. Baseline budget files remain untouched; parent uses exact relocation provenance/allowances where necessary.

## 6. Focused acceptance and integration order

### Worker controls

A:

- Old/new exported identity, semantic catalog and signature-object identity.
- Full legacy intrinsic-type compatibility, including provider-only feature admission through the runtime contract.
- Exact async diagnostic arrays, canonical serialization/hash and plan ordering.
- Positive and negative evidence-class checks using the single effect authority.
- Combined bad-version/bad-arguments/bad-result fixtures to pin ordering.

B:

- Complete catalog/order/object-identity comparisons.
- Provider-only `math.reduce-trig` dependency closure.
- Wrong callable target/composite, unavailable policy, missing provider and mixed backend projection.
- Builder state transitions, failed freeze, late requests and error identity.
- Async currentness: swapped provider order, detached records, stale manifest, wrong owner, missing requirements, mutable state bodies and layouts.
- WeakMap failure/retry controls and unchanged-container identity.
- Exact concat-family validation; do not replace `stringConcatManyArityCap` with a literal.

### Source-produced integration

Reuse the existing typed preparation, codec and replay harnesses. Pin a nonempty JS-source fixture matrix before execution:

- Math intrinsics including a provider-dependent trig case.
- Numeric/boolean/extern boundary cases under their existing supported policies.
- Native async suspension, numeric bridge and undefined completion.
- Multi-source ordering, aliases, globals/startup and TDZ.
- A source-produced prepared async body transformed by the existing passes and subsequently authenticated.

Compare baseline/candidate complete prepared serialization, manifest/provider vectors, attachment identities where observable, binaries, WAT, import/order/pool receipts and executed values. Run the existing GVN off/on and source-order dimensions; retain every refusal and failure row.

Add fresh-process admission of the canonical semantic/provider roots using the existing source-free harness. Keep this distinct from proving the entire historical preparation entry source-free. An empty plan/catalog/body population cannot satisfy admission.

Unsupported physical allocation must remain an exact owner/location/error result—not be removed from the fixture matrix or counted as execution success.

### Order

1. Parent publishes this contract and resolves exact ownership intersections.
2. A/B implement disjoint maps concurrently; freeze shared exports before composition.
3. Parent composes and integrates the four consumer imports.
4. Reconstruct historical receipts, then run focused semantic/provider, boundary, source-produced replay and normal scoped checks serially.
5. Publish the bounded checkpoint with actual results and remaining failures. No hold changes follow from this specification.

## 7. Remaining obligations

This checkpoint closes the named semantic and provider implementation subgraphs. It does not certify the full verifier or middle end.

Follow-on dependencies remain explicit: declared-type verification, producer/tag-domain defaults, fnctor contracts, counted-string provenance’s AST-plan link, string semantic/native limits, dominance ownership, and ordered prepared-body verification. The whole verifier must eventually separate semantic checking from program-level prepared checking without losing those observations.

Native object/vector/closure/boxed/string materialization, required runtime bodies, complete backend acceptance and public IR-only default cutover remain required. Preserve P/C evidence and existing host/linear behavior.

The ABI denominator remains **30**, with the `planningSealed` public-caller obligation unresolved. Neither this extraction nor clean dependency closure supplies that missing witness. Strict closure and direct-codegen retirement remain unproved.
