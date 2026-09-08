# Next checkpoint: canonical whole-program data boundary

Proposed against `19971c634b920f4a6a3fe058dfc3437be3a499ea`; prerequisite PR5745 remains held. Astra High implementation specification with final amendments and coordinator reconciliation below. Approved for plan publication; exact ownership reconciliation remains mandatory before implementation dispatch.

## Decision and scope

Complete the **connected input-and-prepared-program data contract** before implementing native backend materialization.

The typed transaction now exists. Its remaining type dependencies still lead through AST scanners, provider implementations and mixed `program.ts`. Closing and physically placing the complete handoff gives frontend, preparation, codec and backend one canonical contract without importing those implementations.

This checkpoint must not claim that moving declarations also cleans the value-import closure of `prepareTypedIrProgram`. Its implementation, validation, provider selection and codec remain explicit migration debt until separately extracted.

Native allocation materialization follows the clean preparation/physical-reservation boundary. Adding object support through the existing context-dependent consumer now would not establish that boundary.

## Grounded findings

I read Maxwell’s [complete notes](/private/tmp/js2-3518-typed-preparation-source-20260908/.tmp/typed-source-data-boundary-notes-19971.md), [declaration census](/private/tmp/js2-3518-typed-preparation-source-20260908/.tmp/typed-source-data-closure-19971.json), current source and the approved layering plan.

- Input roots reach 235 named declarations in 26 defining files: **177 already canonical; 58 remain in 11 mixed modules**. Reuse the 177.
- The census has no unresolved named references, but is syntactic—not checker or whole-module closure proof.
- Retain all three existing `unknown` leaves: two internal failure causes and allocation metadata.
- `program.ts` must be split. Its prepared data sits beside `LinearOptions`, backend acceptance tokens, emitted Wasm contracts and legacy candidate transactions.
- `FrozenRuntimeManifest` and provider definitions contain IR signatures/operations. Their complete schemas belong in **`ir/runtime`**, not `runtime/contracts`.
- Held startup and ABI extractions are absent from `19971`. Historical implementation is not integrated authority.

## Proposed disjoint source map

Paths below are repository-relative. New paths are proposed canonical owners; old modules explicitly import/re-export moved names. No new canonical module may import an old facade.

### Worker A: source and program data contracts

1. `src/shared/contracts/ir-preparation-failure.ts`

   Move the exact `IrFallbackReason` union from `select.ts`, plus `IrPreparationStage`, `IrUnsupportedCode`, `IrInvariantCode`, `IrPreparationFailure` from `outcomes.ts`. Keep selector behavior, error classes, classification and outcome policy in their existing modules.

2. `src/shared/contracts/ir-unit-inventory.ts`

   Move Maxwell’s complete 13-declaration inventory group from `identity.ts`: source/class/unit records, private record base, support/terminal unions, kinds, synthetic class role and `IrUnitInventory`.

   Import canonical identity brands and `CompilerSourceProducer` directly. Preserve original filenames, legacy evidence, support population, ownership and source spans.

3. `src/ir/program/startup.ts`

   Move the exact twelve declarations at `module-init-plan.ts:9–94`. Builder, AST verifier, invariant error and legacy reconciliation remain old. Reconcile the held startup work first; do not independently recreate or overwrite it.

4. `src/ir/program/callable-bindings.ts`

   Move only `IrProgramCallableBindingKind` and `IrProgramCallableBindingRecord`. AST-bearing uses, graph construction and `resolveCall` remain frontend-owned.

5. `src/ir/analysis/contracts/allocations.ts`

   Move `AllocSite`, `AllocRegistryProvenanceSnapshot`, `AllocRegistryMetadataSnapshot`, `AllocRegistrySnapshot`. Import canonical core types. Registry mutation, capture and restoration remain in `alloc-registry.ts`.

6. `src/ir/passes/contracts/gvn.ts` and `src/ir/program/controls.ts`

   Move `IrGvnMode` and `IrPreparationControls`, respectively. `GvnCounters` remains transaction diagnostics—not packet data or encoded program state.

7. `src/ir/program/abi.ts` and `src/ir/program/abi-lookup.ts`

   Extract the complete declaration dependency set for `ProgramAbiPlanEntry` and `ProgramAbiDerivedUnitRecord`: slot-policy/space types, callable signature, intent and its helper unions, order key and plan base.

   Also move `PreparedComponentAbiEntry` and `PreparedComponentAbiLookup` from the dependency scanner. Preserve optional lookup methods exactly.

   **Do not move or modify `ProgramAbiMap`, its constructor specialization, sealing/getters, binding machinery or legacy adapter.** This avoids deciding the pending ABI compatibility question.

8. `src/ir/program/input-contracts.ts`

   Move `TypedIrProgramGlobal`, `TypedIrProgramInput`, `TypedIrProgramOptions`, referencing the canonical dependencies above and Worker B’s policy contract.

9. `src/ir/program/prepared-contracts.ts`

   Extract these ten declarations from `program.ts`:

   `PreparedIrAbiContract`, `PreparedIrAbiEntry`, `PreparedIrAbiSnapshot`, `PreparedIrProgramProducerInput`, `PreparedIrProgramFailure`, `PreparedIrProgramRuntimeProjection`, `PreparedIrProgram`, `IrProgramPreparationResult`, `PreparedIrProgramOwner`, `PreparedIrSourceLocation`.

   Preserve existing `IrModule` attachment compatibility through Worker B’s prepared-module type; do not silently substitute semantic-only `CoreIrModule`.

10. `src/ir/program/index.ts`

    Explicit type exports for this complete data API. It must contain no old-module forwarding or preparation implementation imports.

A’s existing definition-owner writes are:

`identity.ts`, `select.ts`, `outcomes.ts`, `module-init-plan.ts`, `program-callable-bindings.ts`, `alloc-registry.ts`, `program-abi.ts`, `prepared-component-dependencies.ts`, `program-input.ts`, `program-middleend-ir.ts`, `passes/gvn-core.ts`, `program.ts`.

The adjacent lifted-provenance declarations are **not required by these roots**. Leave them in place rather than adding an unrelated extraction.

### Worker B: policy, manifest and prepared-runtime data

1. `src/runtime/contracts/host-capability-schema.ts`

   Reconcile the already-reviewed 39-declaration capability extraction, including `ResolvedRuntimeHostCapabilityFuncFamilyRow`. Catalogs, factories, guards and validators remain old. Do not duplicate the held draft.

2. `src/runtime/contracts/async-provider-schema.ts`

   Move the ten data declarations:

   `ASYNC_HOST_CAPABILITY_IDS`, `AsyncHostCapabilityId`, `AsyncHostAdapterValueType`, `ASYNC_CALLBACK_EXCEPTION_POLICY`, `AsyncCallbackExceptionPolicy`, `AsyncHostAdapter`, `PreparedAsyncHostCapabilityId`, `PreparedAsyncHostAdapter`, `ASYNC_RUNTIME_PROVIDER_IDS`, `AsyncRuntimeProviderId`.

   Preserve the narrower async value union. Provider objects, adapter catalogs and authentication functions remain old.

3. `src/runtime/contracts/provider-policy.ts`

   Move Maxwell’s sixteen policy declarations, plus `FrozenRuntimeManifestPolicy` and their thirteen existing disabled-policy constants. These have no IR dependency.

4. `src/ir/runtime/contracts/intrinsics.ts`

   Extract intrinsic runtime-feature vocabulary and data declarations through `IntrinsicVerificationFailure`. Preserve existing canonical intrinsic IDs. Signature objects, definition catalogs, `IntrinsicEffectEvidence` and verifier implementations remain old.

5. `src/ir/runtime/contracts/manifest.ts`

   Move the remaining manifest/provider data declarations and closed vocabulary constants from `runtime-manifest.ts:76–1059`, after removing the policy group above, plus `RuntimeProviderPlan`, `RuntimeProviderComponent`, `FrozenRuntimeManifest`.

   Keep `projectRuntimeBackendRequirements`, `RuntimeManifestBuilder`, invariant errors, provider construction/catalogs and selection algorithms old. Preserve optional signature presence, provider order and the single concat-family arity constant.

6. `src/ir/runtime/contracts/prepared.ts`

   Move the complete prepared function/module and async attachment declarations from `async-plan.ts`, plus `PreparedIrRuntimeManifest` from `intrinsic-support.ts`.

   Keep `preparedManifestByPlan`, attachment creation/currentness/sealing and state-body mutation in their existing authority modules. No cloned provider authority or second WeakMap.

7. Explicit contract-only indexes under `src/runtime/contracts/index.ts` and `src/ir/runtime/index.ts`.

B’s existing definition-owner writes are:

`runtime-host-capabilities.ts`, `async-runtime-providers.ts`, `runtime-manifest.ts`, `intrinsics.ts`, `async-plan.ts`, `intrinsic-support.ts`.

This runtime map has been reconciled with Boyle's completed handoff. The final amendments below specify exact ownership, attachment types and retained implementation boundaries.

### Parent: consumer integration and gates

Directly retarget canonical type imports in:

- `program-source.ts`
- `program-prepare-ir.ts`
- `program-abi-contracts.ts`
- `program-codec.ts`
- `program-validation.ts`
- `program-population.ts`
- `program-runtime-abi.ts`
- `runtime-program-producers.ts`
- `runtime-program-manifest.ts`

Keep their runtime calls unchanged. Other historical consumers retain downward compatibility imports.

Parent owns policy, issue/plan and test integration. No package-command amendment is presently necessary.

## Lifecycle and interface invariants

The unchanged production chain remains:

`runIrProgramDriver → prepareWholeIrProgram → prepareIrProgramSources → captureTypedIrProgramInput → prepareTypedIrProgram`

These are real internal compiler callers—not evidence of public cutover.

Preserve:

- Scanner metadata and AST identities outside the transported inventory.
- Dependency-first startup order, including empty sources.
- Callable alias/canonical/target IDs and all ordinals.
- Exact source/global/value/TDZ ownership joins.
- Allocation sharing, aliases, retirement, explicit `undefined`, unknown namespaces and next identity.
- Semantic freezing **before** runtime attachment authentication.
- Exact provider objects, manifest order, layouts and currentness checks.
- Canonical Promise callable results versus body fulfillment types.
- Resolved options, GVN failure counts, original thrown errors and once-only legacy publication.

Internal `IrPreparationFailure.cause` remains optional `unknown`. `runtime-program-manifest.ts::locatedFailure` continues stripping it before producing serializable diagnostics. Do not erase that distinction or tighten the public type as an incidental relocation.

## Tests and boundary acceptance

Add three focused suites:

- `tests/issue-3518-program-data-contract-seam.test.ts`
- `tests/issue-3518-program-data-contract-boundary.test.ts`
- `tests/issue-3518-program-data-contract-replay.test.ts`

They must prove:

1. Compiled old/new type equality, canonical brands, complete unions and optional/readonly/never fields. Missing imports or declarations must fail.
2. Actual type-and-value module closure of every canonical contract root, including barrels, import types, type queries and aliases.
3. Negative backedges to identity/select/startup/callable scanners, old `program.ts`, provider implementations and linear/codegen modules.
4. Same-object identity for moved vocabulary constants; no duplicate initialization/catalog authorities.
5. Real frontend capture and preparation/codec replay with aliases, reversed sources, startup, global ownership, allocation metadata and retained refusals.

Update `tests/issue-3518-core-nodes-seam.test.ts` only to account for the exact moved async declarations: **retained plus moved declarations must reconstruct the old denominator; all 39 retained function bodies and the currentness WeakMap remain accounted for.**

Keep the 169 integrated controls and 439 normal-hook results as separate historical scoped receipts—not a summed coverage claim. Preserve N1 six, core-type ten, core-node twelve and their existing unknown/cut semantics.

D0 activation must require every new canonical path, with no existence fallback. No existing active root or allowed edge is relaxed. Analysis/pass contract subroots need an explicit parent-reviewed activation map; their remaining implementations stay inventoried debt, and broader folder completion remains required.

Crucially, report two different results:

- **Canonical contract closure:** must pass type and value boundaries.
- **Existing preparation implementation closure:** remains separately reported; contract extraction cannot turn its old value dependencies into a passing closure claim.

## Integration order and retained gaps

1. Parent reconciles exact paths against current claims and held startup/ABI/capability work.
2. Freeze cross-worker declaration/export maps.
3. Integrate foundations and runtime schemas, then program contracts, then real consumer imports.
4. Run declaration preservation, compiled type controls, dependency gates and existing replay/preservation checks serially.
5. Publish a non-draft held checkpoint with all remaining debt.

This fits the approved architecture without a new user decision. It does not authorize resolving the ABI getter question.

Backend gaps remain unchanged: native allocation/materialization, runtime callables, strings/callbacks and async resources. The historical live record still fails emission; vector and async refusals remain counted. Executed live-allocation proof remains open.

The next implementation milestone after this data boundary is relocating the **actual preparation/value closure**, followed by a clean standalone physical-reservation/emission transaction. Neither declaration placement nor held publication proves direct-codegen retirement.

No source changes, tests, claims, dispatches or CI watchers were started for this plan.

## Coordinator reconciliation — 2026-09-08

The coordinator has read both complete source-data and runtime dependency handoffs. The following supersedes any earlier prospective wording above:

- Boyle's runtime map is complete, pinned to the same 19971c6 source. Whole-program runtime ownership/population wrappers remain in ir/program; ir/runtime must not import ir/program.
- Reuse the published startup extraction from PR5741, head 7b37b23c72af84a1e336cebce2954942408ecea6: module-init-plan.ts imports/reexports the twelve declarations in ir/program/startup.ts, with builder behavior unchanged. Do not reimplement it.
- Reconcile ABI declaration extraction against held PR5739 before authorizing program-abi.ts writes. Do not adopt the pending planningSealed getter, duplicate ABI authority, or overwrite that checkpoint. Reconcile the capability schema against held PR5743 likewise.
- Declaration placement does not close verify -> counted-string-append-provenance -> ast-lowering-plans. Semantic intrinsic verification also remains mixed with provider authentication. These require subsequent implementation separation, not relaxed dependency rules.
- Preserve explicit prepared function/module attachment types, exact plan/manifest/provider/layout identity, and in-place authenticated freezing. Semantic-only core types cannot erase prepared attachments.
- The latest authoritative assignment revision is ed53d4e1e9f4c9701212ed1d91957a5eebceefa0, containing the existing typed-program-preparation-boundary claim. Local upstream/issue-assignments is stale. No new claim or implementation dispatch has been made for this draft.
- PR5745 at 19971c634b920f4a6a3fe058dfc3437be3a499ea completed its existing watcher with exit 0: 28 passing checks, 14 skipped, none failed. Fresh PR state was MERGEABLE/CLEAN with no unresolved reviews, non-draft, hold retained and auto-merge disabled. This is checkpoint evidence, not whole-migration acceptance.

Before dispatch, finish the exact cross-worker export map and reconcile the ABI/capability reuse paths with the existing held source. Preserve all prior runtime/compiler caller and complete population checks. All implementation and this plan must be published in non-draft held loopdive/js2 PR checkpoints; no direct-main changes, queue operations, or global model/config changes.



## Final Astra High amendments — authoritative over the initial map

Read both complete handoffs and the saved plan. These are the remaining amendments against `19971c6`; no files changed.

### 1. Replace A7 with declaration-only ABI reuse

Do **not** copy PR5739’s complete `program/abi.ts`: it contains the runtime class and therefore carries the unresolved moved-getter proof obligation.

Parent should reconcile a declaration-only subset at the **same canonical destination**, `src/ir/program/abi.ts`, reusing these seven declarations verbatim from the held extraction:

- `ProgramAbiSlotPolicy`
- `ProgramAbiSlotSpace`
- `ProgramAbiCallableSignature`
- `ProgramAbiDerivedUnitRecord`
- `ProgramAbiIntent`
- `ProgramAbiOrderKey`
- `ProgramAbiPlanEntry`

Include their five private dependencies: `ProgramAbiSlottedIntent`, `ProgramAbiAliasIntent`, `ProgramAbiNonExportIntent`, `ProgramAbiExportIntent`, `ProgramAbiPlanBase`. Imports resolve directly to canonical identity brands; documentary links may be adjusted.

Old `program-abi.ts` imports/reexports those seven names. **Its existing `ProgramAbiMap`, constructor, every method/getter, error class, final-index type and legacy adapter remain unchanged.** No constructor specialization or `planningSealed` relocation is adopted.

Cancel proposed `program/abi-contracts.ts`. Put only `PreparedComponentAbiEntry` and `PreparedComponentAbiLookup` in new `program/abi-lookup.ts`, importing canonical `ProgramAbiPlanEntry`; preserve both optional lookup methods. The dependency scanner imports/reexports those two names.

PR5739’s `program/abi-inventory.ts` is needed by its generic map, **not this declaration-only cut**. Reserve it to that checkpoint; do not introduce an unused duplicate.

This requires parent reconciliation with PR5739 ownership before dispatch—not acceptance or silent composition of that entire PR.

### 2. Make published reuse explicit

**Startup:** reuse PR5741 head `7b37b23c…`: canonical `program/startup.ts`, old-module imports/reexports, the `program.ts` import adjustment and existing startup controls. No second twelve-declaration implementation. Parent serializes the shared `program.ts` integration.

**Capabilities:** reuse PR5743’s exact 39-declaration extraction, including `ResolvedRuntimeHostCapabilityFuncFamilyRow`, through:

- `src/runtime/contracts/host-capability-schema.ts`
- Old `runtime-host-capabilities.ts` imports/reexports
- `tests/issue-3518-capability-schema-seam.test.ts`
- `tests/issue-3518-capability-schema-boundary.test.ts`

Reconcile its policy/test integration against current active roots; do not overwrite current policy with the older checkpoint version. Catalogs, guards, factories and validators remain their original objects/implementations.

These are parent composition dependencies, not fresh Low reimplementation assignments.

### 3. Finish the attachment/export contract

B6’s exact moved group is:

`PreparedIrFunction`, `PreparedIrModule`, `PreparedIrAsyncHostAdapter`, `PreparedIrAsyncRuntimeBase`, `PreparedIrAsyncRuntime`, `CurrentPreparedIrAsyncRuntime`, `PreparedIrAsyncRuntimeInput`, plus `PreparedIrRuntimeManifest`.

Keep the base private inside its canonical module. Export `PreparedIrAsyncRuntimeInput` only as needed for the old implementation’s type import; do not newly reexport it through the historical API. Existing public names retain explicit old-module type forwards.

The joins must remain:

- Typed input → semantic core `IrModule`.
- Prepared program and runtime projections → exact **prepared** function/module extension.
- Core → no prepared/runtime/program dependency.

`program/index.ts` should explicitly export the three input types, `IrPreparationControls`, and the ten prepared-contract declarations already enumerated in A9. Other contracts remain available from their named canonical modules. No wildcard or mixed-module forwarding.

### 4. Incorporate Boyle’s placement and lifecycle constraints

Replace “forthcoming handoff” with the completed evidence:

- Whole-program producer/manifest wrappers ultimately belong in **`ir/program`**, because they consume program ownership/population contracts. Never move them into `ir/runtime`.
- Keep backend options, `LinearOptions`, acceptance brands/tokens, emitted Wasm contracts and consumer transaction authority outside the clean program-data module.
- Preserve semantic freeze before authentication, then **in-place** authenticated runtime freezing.
- Preserve extern-support’s copy-on-write prepared-state updates and prepared-vector layouts’ exact logical-type identity.
- Keep the single attachment WeakMap and all currentness/replay authentication. Decoded shape alone grants no authority.

### 5. Add narrowly targeted acceptance controls

Alongside existing proposed controls, require:

- ABI moved declaration equality **and unchanged retained runtime-class/getter/error bodies**; no class caller obligation disappears.
- Prepared attachment fields survive compiled old/new type comparisons and actual replay.
- Copied-but-unauthenticated manifests/layouts retain existing rejection behavior; relocation cannot substitute structural equality for identity.
- Destination deletion, missing type imports and old-facade backedges fail mandatory boundary checks.
- Retained-plus-moved declarations reconstruct existing receipt denominators, including the async seam.

No weakening of existing six/ten/twelve caller groups, strict unknowns or execution-witness cut status.

### 6. Keep the next value-boundary work explicit

This checkpoint closes the **connected data handoff**, not preparation’s implementation closure. Remaining concrete blockers include:

- `verify → counted-string-append-provenance → ast-lowering-plans`.
- Semantic intrinsic verification mixed with provider authentication.
- Semantic async verification sharing the attachment implementation.
- Whole-program ownership wrappers and mixed cloning/freezing utilities.

These require subsequent implementation splits; `ir/analysis` must not gain runtime imports to accommodate them.

Native allocation execution remains unresolved. Provider selection, preparation success and serialization do not prove physical materialization or complete reservation.

With these amendments, the plan is ready for parent publication and exact ownership reconciliation—not dispatch authorization or whole-migration acceptance. No further architectural user choice is required for this data-only scope; the ABI getter question remains untouched.

## Coordinator acceptance

The coordinator read the complete final amendments and accepts this connected data-only design for publication. The seven ABI declarations and five private dependencies will reuse the exact held canonical definitions; the old runtime class, error class and getter remain unchanged, and the original 30-target ABI proof obligation remains unresolved. This does not settle the outstanding acceptance question. Startup and capability extraction are parent-owned prerequisite composition, not duplicate worker assignments. Claims and exact file ownership must be reconciled before implementation; no test or migration criterion is waived.
