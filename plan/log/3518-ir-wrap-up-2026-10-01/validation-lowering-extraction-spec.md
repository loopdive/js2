# Issue 3518 — genuine validation and lowering extraction prerequisite

Date: 2026-10-01. Read-only architect analysis of `/private/tmp/js2-ir-genuine-mixed-get-call-20261001`, branch `codex/3518-genuine-mixed-get-call-20261001`, starting revision `e4737c9f1dcb632c56f3cc3a31e3ad47cd7f848e` (pending PR 6371 dependency). Root owns claims, metadata, integration and validation. The writer owns the frozen seven-file source identity implementation. This document assigns proposed implementation responsibilities; it does not authorize another writer or change any tracked file.

The root reports TS7 exit 0 and 43/43 focused identity controls for the frozen draft. I did not run those checks. Its import closure is explicitly a static analysis, not a successful boundary validation. The candidate cannot land in its present module arrangement. This prerequisite preserves the tested source identity work and full validation rather than bypassing either.

## Decision and completion boundary

`clean` is a dependency-closure claim under the actual checker. `scripts/check-compiler-boundaries.mjs:425–447` requires every module beneath an active root to be clean in that root's layer. Lines 483–487 and 551–552 reject a clean module importing migration debt; lines 595–624 also check transitive paths, including type-only edges. These checks apply in inventory mode. Keeping the whole-compiler complete verdict FAIL does not license invalid inventory in an active root.

The source-target owner imports `assertPreparedIrProgram`; the physical source owner also imports generic lowering, concrete emitters, the Wasm converter and their contracts. Those donors are real remaining debt. Their local code being physical/data-only is not an exception. Existing clean `backend/wasmgc/program/native-realm.ts` and `backend/wasmgc/async/prepared-async-frame-adapter.ts` depend on genuinely separated requirements/contracts/engines and do not justify these imports.

The writer's static graph contains 1,579 modules reachable from the target owner because old facade imports expose whole compiler/type graphs. This is not a requirement to rewrite 1,579 modules. The dependency cuts below remove that fan-out by moving real declaration/body owners and using already canonical leaves. No new allowed edge, relaxed layer, dynamically loaded validator, callback validation permit, duplicate private registry, class copy, or fake completion packet is involved.

Done for this prerequisite means BOTH new roots have genuinely valid complete import closures under the unchanged layer-edge policy, their original runtime behavior and full checks remain, and the source issuer remains the one private owner. Whole-compiler strict completion must continue to report its actual remaining debt. Full source Call modes, general Get/Call/Construct, all 45 intrinsic identities / 44 Call algorithms and lifted entries / two intrinsic Construct entries, dynamic Function/eval/with, both-backend equality and legacy retention remain obligations. This extraction grants none of those semantics.

## Already separated symbols: repoint, do not reimplement

Use these exact owners in the newly extracted implementations. Leave old facades available to existing callers. A value imported through a facade must remain the same value after the move.

| Mixed import currently encountered | Canonical clean owner and precise use |
| --- | --- |
| `ir/nodes.ts` semantic instruction/value/type/walk names | `ir/core/nodes.ts`, `ir/core/types.ts`, `ir/core/value-references.ts` as applicable. Where the old `IrFunction` means the prepared attachment-bearing type, import `PreparedIrFunction as IrFunction` from `ir/runtime/contracts/prepared.ts`; never silently erase `asyncRuntime` checks. |
| `ir/types.ts` | `wasm/model/instructions.ts` for Instr, ValType, LocalDef, BlockType; `wasm/model/module-records.ts` for FuncTypeDef, WasmFunction and other module records. Handles use the established physical handle owners when needed. |
| `ir/callable-bindings.ts` | `ir/core/callable-bindings.ts`: the existing binding keys, equality, unit IDs and reference factories. |
| `ir/identity.ts`, `ir/identity-values.ts` | `shared/contracts/ir-identity.ts`, `ir-unit-inventory.ts`, `identity-values.ts`. Do not carry frontend-rich inventory aliases. |
| `ir/program-abi.ts::ProgramAbiMap` | `ir/program/abi.ts`. The old value is exactly `CanonicalProgramAbiMap<IrUnitInventory>`, not a distinct constructor. Preserve constructor identity and the original inventory object; no shadow ABI registry or lossy projected inventory. |
| `ir/program-abi-contracts.ts` signature/key helpers | `ir/program/abi-signatures.ts`: preparedIrTypeKey, preparedIrDataKey, preparedIrClassLayoutKey, preparedIrCallableSignature. The actual draft lookup function is a remaining extraction below. |
| `ir/program-population.ts` | `ir/program/population.ts::assertPreparedIrProgramPopulation`, already the real implementation. |
| `ir/program-callable-contract.ts` | `ir/program/callable-results.ts::preparedIrProgramCallableResults`. |
| `ir/program.ts` data/errors/types | `ir/program/data.ts`, `errors.ts`, `prepared-contracts.ts`; only `preparedIrProgramOwner` still requires a body extraction below. |
| `ir/program-runtime-abi.ts` identity helpers | `ir/program/runtime-abi-identity.ts` for preparedIrRuntimeAbiAnchor and preparedIrRuntimeCallableBindingId. |
| `ir/runtime-callable-declarations.ts` | `ir/runtime/callable-declarations.ts`, actual canonical registry. |
| `ir/async-plan.ts` attachment helpers | `ir/runtime/async-attachment.ts`; semantic plan checks use `ir/analysis/async-plan.ts`, semantic types `ir/core/async-plan.ts`. Preserve private attachment currentness. |
| `ir/async-semantic-runtime.ts::IR_ASYNC_STRING_CONCAT_5_FN` | `ir/core/async-callables.ts`. |
| `ir/effects.ts` | `ir/analysis/effects.ts`, including the existing emission schedule verifier. |
| `ir/alloc-registry.ts` | `ir/analysis/alloc-registry.ts` and `analysis/contracts/allocations.ts`. This is the same registry/class/namespace authority. |
| `ir/js-tag.ts` | `runtime/contracts/js-value-tags.ts` for JsTag and jsTagUnboxKind. Do not put that runtime contract behind a newly forbidden core edge. |
| `ir/try-table.ts` | `wasm/physical/exception-control.ts`: exact StandardEhHandler, buildStandardTryTable and buildTargetTaggedTry. |
| `ir/abi-bindings.ts::irTypeBindingKey` | `ir/core/type-binding-keys.ts`. `irGlobalBindingKey` still needs its real body moved. |
| `ir/string-runtime.ts` encoding/mode types and existing concat identities | `ir/core/string-types.ts` and `ir/core/string-callables.ts`. Other remaining definitions are addressed below, not reconstructed from strings. |

There is no already-clean full prepared-program validator, full generic lowerer or full WasmGC emitter to substitute. `assertNativeSourceClosureRequirementsCurrent` is not one: its producer documents that the coordinator additionally authenticates the entire prepared program. Its exact source/projection census is necessary but does not replace verifier/ABI/startup/allocation/runtime checks.

## Ordered implementation sequence and ownership

Each phase is one independently reviewable responsibility. Root can dispatch sequentially or partition disjoint leaves, but must inspect authoritative claims first. Where a later phase depends on a new leaf, do not land its active-root importer ahead of that leaf. Preserve the current seven-file draft and its 43-row evidence unchanged until the relevant integration phase. Root's three parameter-preservation files (`vec-layout.ts`, `string-carrier.ts`, `physical-ref-support.ts`) are excluded from this plan.

### A. Small closed semantic contracts and identity-bearing exceptions

Owner A owns the following new canonical files and only the named donor spans/imports/re-exports. New paths are proposals for real implementations, not forwarding wrappers toward debt.

1. **NEW `src/shared/contracts/ir-preparation-errors.ts`**, from `src/ir/outcomes.ts`: move the actual `IrUnsupportedError`, `IrInvariantError`, `demoteToLegacy`, and `classifyIrFailure`, with their complete comments/constructor bodies. Import only existing shared failure types. The old outcomes module imports/re-exports the same classes/functions for its remaining outcome reporting. Do not copy classes: existing `instanceof`, cause identity and classification behavior must remain exact. `PreparedProgramAbiCommitError` and module-binding outcome reporting can stay in the mixed donor; neither is needed by these roots.
2. **NEW `src/ir/core/global-binding-keys.ts`**, from `src/ir/abi-bindings.ts`: move `irGlobalBindingKey`, `sameIrGlobalBinding` and the exact private `requireString` dependency (if shared with retained factories, both use this one exported/internal canonical primitive rather than duplicate it). Reuse the current clean binding-key primitives, including the capability-aware source-global grammar. Keep factories and rich identity imports in the old facade until separately needed.
3. **NEW `src/ir/core/declared-types.ts`**: move the actual declaration-table validation/key implementation of `src/ir/declared-types.ts`; repoint semantic types/ValTypes to canonical leaves. Keep conservative missing-declaration semantics, all compatibility checks, and the one `irBindingKey` grammar. Old path re-exports it.
4. **NEW `src/ir/core/fnctor-abi.ts`**: move the actual `src/ir/fnctor-abi.ts` implementation, not only interfaces. Its resolved fields are symbolic IrTypeRef/IrFuncRef, not raw backend indices. Existing core shapes/types are its complete imports. Preserve validation, nominal equality, hidden identity/capture parameter ordering and old value/type exports.
5. **NEW `src/ir/core/tag-domain.ts`**, actual neutral contract from `src/ir/tag-domain.ts`; **NEW `src/ir/runtime/js-tag-domain.ts`**, actual JsTag mapping/coercion domain from `src/ir/js-tag-domain.ts`; **NEW `src/ir/runtime/producer.ts`**, actual pure producer lookup from `src/ir/producer.ts`. Retain one JS_TAG_DOMAIN object and one default-producer binding. Runtime can depend on runtime-contracts plus core; core must not import runtime-contracts or a concrete JS domain. Keep old-path exports and non-JS domain behavior.
6. **NEW `src/ir/core/string-runtime.ts`**, the remaining data/specification/symbol implementation in `src/ir/string-runtime.ts`, with its exact existing dependency on core/string-callables. Re-export the already canonical encoding/mode/concat names rather than duplicate them. Move the real remaining symbols, counted-repeat limits/predicate, concat-arity parser and specification table. Existing readers retain the old facade. This avoids repeatedly splitting one small self-contained semantic vocabulary and preserves its single authority.
7. **NEW `src/shared/contracts/ir-counted-string-site-id.ts`**, only the closed identity grammar family from `src/ir/counted-string-append-provenance.ts`: SITE_PREFIX/SITE_PATTERN, source/unit/class patterns and kind authorities, depth bound, canonicalPosition, canonicalIdentityComponent, parseCanonicalIdentityComponent, hasCanonicalOrdinal, the mutually dependent source/lexical-owner/unit/class validators, createIrCountedStringAppendSiteId, parseIrCountedStringAppendSiteId, irCountedStringAppendSiteIdIsCurrent, assertUniqueCurrentIrCountedStringAppendSites. Reuse the existing shared identity types; do not alter their prior receipt. Leave DIGEST_PATTERN, AST lowering plans, digest/final artifact association, provider authentication and their errors in the original provenance donor. Old APIs import/re-export the same grammar functions. This is a real cut: verifier only needs the parser, not AST authority.
8. **NEW `src/shared/contracts/string-surrogate.ts`**, move the existing import-free `src/string-surrogate.ts` implementation (STRING_CONSTANTS16_NS, hasLoneSurrogate, hexCodeUnits); old path re-exports. No alternate surrogate scanner.
9. **NEW `src/ir/core/runtime-symbols.ts`**, move all four existing constants from `src/ir/runtime-symbols.ts`; retain old facade. These are canonical symbolic IDs, not provider grants.
10. **NEW `src/ir/core/date-callables.ts`**, actual IrHostDateSnapshotGetter union plus the prefix/symbol/parser bodies currently in `src/ir/date-runtime.ts`. Move only that union out of `src/ir/ast-lowering-plans.ts` and import/re-export it there; all AST plan authority remains in the original module. Never import the AST plan module into a clean lowerer just to obtain this three-value union.

A may be divided into small commits by independent contract family. Register each genuine closed file only after its imports are clean. Root must preserve historical declaration tests using authenticated relocation composition (section below), not refresh old hashes.

### B. Existing analysis and verifier bodies, with full checks

Owner B owns the following actual donor bodies. No frontend/compiler selectors are part of this phase.

1. In-place import repoints in **`src/ir/analysis/lattice.ts`, `ownership.ts`, `encoding.ts`, `escape.ts`, `dominance.ts`**. Lattice is already import-free; the other bodies need only canonical allocation/core/string types plus this analysis family. Activate these exact paths once their closed graph is proved. Keep `dominance.ts`'s one WeakMap/cache; do not create a second analysis owner. Keep original mutator behavior of ownership/escape/encoding on the existing registry namespaces.
2. **NEW `src/ir/analysis/alloc-verification.ts`**, from `src/ir/verify-alloc.ts`: actual ALLOC_INSTR_KIND, AllocVerifyError, verifyAllocProvenance, checkId, assertFinalAllocProvenance, assertVerifiedAllocProvenance and nested traversal helpers. Use canonical registry/core/error owners. Keep `allocVerifyEnabled` and the optional intermediate `assertAllocProvenance` environment wrapper at the old mixed path, delegating to the real final verifier only when enabled. Required final verification remains unconditional; missing debug flags cannot turn it off. Existing callers/exports remain compatible.
3. **NEW `src/ir/runtime/verify.ts`**, the complete actual `src/ir/verify.ts` implementation, including ALL instruction rules, structural binding validation, parameter/return checks, async plan/attachment checks, declared signatures, dominance, counted-string site checks and error ordering. It belongs above runtime contracts: `verifyIrIntrinsicInstruction` and PreparedIrFunction are real dependencies, so call it `ir-runtime`, not falsely pure `ir-core`/`ir-analysis`. Repoint canonical dependencies from A and the analysis paths above. Preserve the optional `IrVerificationOptions` API and the existing default `JS2WASM_IR_VERIFY_DOMINANCE_NAIVE` cross-check behavior exactly; this relocation does not claim to eliminate ambient debug controls. Do not silently substitute `{verifyDominanceNaive:false}`. Old verifier path re-exports the one implementation and all public types. A future resolved-options refactor is separate, not a prerequisite to correct import closure.
4. **NEW `src/ir/program/allocations.ts`**, move the full `src/ir/program-allocations.ts` implementation. The metadata validator actually re-runs encoding, ownership and escape; these are not optional imports that can be erased. Preserve all live/aliased/retired registry reconstruction, canonical alias/cycle checks, namespaces, semantic and async state body traversal, support-function population, site/result-type equality, and metadata presence-versus-value comparisons. Preserve `analyzeIrRuntimeSupportAllocations` API too. Old path becomes a compatibility facade.
5. **NEW `src/ir/program/class-layouts.ts`**, actual 51-line class-layout validator from `src/ir/program-class-layouts.ts`, canonical types/key/errors only. Preserve nominal layout equality, duplicate declarations, recursive traversal and accessor rejection. No synthetic class admission is added.

Core-only analyses should import CoreIrFunction where they never read asyncRuntime. The full verifier must use PreparedIrFunction because it DOES inspect asyncRuntime; replacing the latter with a cast or deleting those branches is prohibited. Require declaration/assignability controls at old and new paths.

### C. Full runtime reconstruction, then the full program validator

Owner C owns these exact extractions, after A/B dependencies are usable.

1. **NEW `src/ir/program/owner.ts`**, actual `preparedIrProgramOwner` from `src/ir/program.ts:81–106`, with its original/derived terminal lookup and location object. No new cache or owner registry. Old program module re-exports it. This removes the `program.ts -> codegen-linear/index.ts` type chain from diagnostics without changing diagnostic authority.
2. **NEW `src/ir/program/draft-abi-lookup.ts`**, actual `preparedIrDraftAbiLookup` from `src/ir/program-abi-contracts.ts:37–44`, depending only on the prepared contracts and existing ABI lookup interface. Preserve the caller-validated pre-seal read contract; do not change it into a second ABI map or call the public lookup recursively. Original donor re-exports it for retained preparation.
3. **NEW `src/ir/program/runtime-support-dependencies.ts`**, only `assertPreparedIrRuntimeSupportDependencies` from `src/ir/prepared-component-dependencies.ts:49–140`. Its body is self-contained with core refs/type equality/binding keys, formatter declarations, prepared types and errors. Move its full traversal exactly. Do NOT import or move the unrelated ~1,700 lines of component ownership, source-class evidence and frontend prepared-instruction support. This retains the actual support algorithm while cutting its unrelated imports.
4. **NEW `src/ir/runtime/generator-support.ts`**, actual `src/ir/generator-support.ts` body with canonical core imports. Preserve the shared numeric return demand enumeration AND actual symbolic provider attachment as one implementation; old path re-exports. Keeping the whole modest source-free file avoids duplicating valueTypesOf/number-box demand policy. No generator ABI/provider algorithms are invented.
5. **NEW `src/ir/runtime/intrinsic-preparation.ts`**, actual remaining `src/ir/intrinsic-support.ts` implementation. Its imports already target canonical core/analysis/runtime leaves. Move its real provider selection, complete input/demand types, IrRuntimeFunctionPreparationError, all private helpers and attachment operations; old path explicitly re-exports all current APIs, including existing intrinsic-verifier re-export. Preserve overloads, class identity, provider objects, prepared attachment identity, clock projection and demand ordering. Do not expose only a stub `prepareIrRuntimeManifest` while hiding its real dependencies.
6. **NEW `src/ir/program/runtime-demands.ts`**, actual `src/ir/program-runtime-demands.ts` body. Use canonical nodes, runtime symbols, async callable constant, string-runtime parser, generator-support and shared surrogate scanner. Preserve all ten returned demand fields and scans over both block and async-plan buffers. No preselected-source approximation.
7. **NEW `src/ir/program/runtime-abi.ts`**, actual `prepareIrProgramRuntimeCallables` and `assertPreparedIrRuntimeCallableDeclaration` from `src/ir/program-runtime-abi.ts`; canonical callable registry/population/key/owner/error helpers. Preserve exact sorted declarations and the existing native async/vector demand validation. Identity helpers continue to come from the current clean runtime-abi-identity leaf.
8. **NEW `src/ir/program/runtime-manifest.ts`**, complete actual `src/ir/runtime-program-manifest.ts`, including diagnostics, checkFunctionPopulation, demand merge and prepareWholeProgramRuntimeManifest. Use the same canonical runtime producer and owner/data/population APIs. This is program coordination over data, not physical reservation or frontend preparation. Preserve host and standalone projection behavior, retained adapters, explicit runtime manifest providers and declaration associations.
9. **NEW `src/ir/program/runtime-validation.ts`**, complete `src/ir/program-runtime-validation.ts`. Preserve both the independent positional `assertClockProjection` witness and deterministic full producer rederivation. Preserve semantic/provider separation, exact state/owner ordering, policy/manifest fields, and canonical async attachment currentness. Do not replace independent checking with only an equality/hash of a cached derived object.
10. **NEW `src/ir/program/validation.ts`**, complete `src/ir/program-validation.ts`, after all preceding imports have clean owners. Keep private validateEntry/validateRuntimeCallables and every exported check. Use the real canonical ProgramAbiMap constructor, full runtime verifier, actual allocation/class/support validators, current ABI signatures and whole runtime reconstruction. The old validation module is an explicit re-export of the SAME function, not a separate implementation with weaker checks. Preserve optional verifier options/default behavior.

For the final validator the retained checklist is executable behavior, not documentation only: schema/sealed/reconciliation; original and derived body population; absence versus own undefined runtimeSupport; canonical support validation; semantic runtime separation; original registry allocation metadata; class layouts; exact terminal-unit receipt count/content; ABI duplicate/order/kind/signature/alias/source ownership; formatter type/kernel/implementation order and position relative to runtime tail; all runtime callable declarations against the real registry; support dependency traversal; plan/seal over the same ProgramAbiMap; every real/support body's ABI and Promise contract; all nested call/closure/global references; full verifier errors; startup sources/bindings/executable-or-empty evidence; nonempty unique selected runtime projections; exact policy and prepared population; independent projection reproduction. No branch may be dropped because the source identity fixtures do not exercise it.

**First meaningful deliverable:** after C, `native-source-call-targets.ts` can import the real clean validator and have a genuine clean graph without waiting for generic lowering. Keep the new source owner unpublished/unenforced until D/E completes. Do not call the whole seven-file checkpoint publishable after this substep.

### D. Actual lowering contracts and Wasm implementation closure

Owner D owns real lowering extraction. New physical declarations stay in the existing backend layer; no new backend-to-legacy edge is added. The implementation remains Wasm-shaped and still supports an abstract sink; this is not a claim of a finished backend-neutral architecture.

1. **NEW `src/ir/analysis/contracts/linear-memory-layout.ts`**, from `src/ir/analysis/linear-memory-plan.ts`, only the complete type dependency closure required by the four handle imports: LinearAllocationSitePlan, LinearRecordLayoutPlan, LinearRuntimeOperation, LinearVectorLayoutPlan. This includes LinearStorageKind, LinearAllocationClass, LinearSizePlan, LinearFieldPlan, LinearPointerMap, private LinearLayoutBase, LinearAllocationDecision, LinearRootPlan, LinearSafepointPlan, LinearBarrierPlan and LinearLifetime. Use existing clean AllocKind/AllocSiteId/IrSiteId, plus the now-clean Ownership/EscapeClass/Encoding type owners. Preserve fields/readonly/optionality exactly. Leave LinearMemoryPlan, allocator policy execution, prepared facts, planners, stack-allocation analysis and constants in the old donor, importing/re-exporting these exact types. The private base must move with its public extending interfaces. This avoids dragging allocation-plan producers into a handle type import.
2. **NEW `src/ir/analysis/backend-legality.ts`**, from `src/ir/backend/legality.ts`: move IrBackendKind, IrBackendLegalityError, IrBackendFnctorResolver and the actual verifyIrBackendLegality plus all checkInstr/backend type/op/nested traversal helpers (current line 142 onward). Repoint nodes, fnctor shape and ValType imports. Leave `projectIrBackendTargetProfile`, its CompileTargetProfile import, IrBackendTargetProfile/Capability and supportsIrBackendTargetCapability in the original configuration adapter, with exact re-exports/imports of moved names. No clean root may import target-profile or a frontend selector to obtain the backend enum.
3. **NEW `src/backend/wasmgc/lowering/handles.ts`**, actual `src/ir/backend/handles.ts` declarations using canonical core, actual runtime JsTag contract, Wasm model and the extracted linear layout types. Keep all existing callbacks/fields unchanged, including source state/identity fields from the validated draft. This is the existing layout seam, not a caller-authenticator or completion callback.
4. **NEW `src/backend/wasmgc/lowering/contracts.ts`**, actual `src/ir/backend/lower-contracts.ts`: IrLowerResolver, public handle re-exports, IrLowerResult and generic lowered-body/signature/value shapes, repointed to the exact canonical owners. Keep argument/return ABI and optional-presence semantics; no added success permit or raw-token completion shortcut.
5. **NEW `src/backend/wasmgc/lowering/string-contract.ts`** and **`emitter-contract.ts`**, actual `src/ir/backend/string-contract.ts` and `emitter.ts` with clean scalar/IR/string/handle/legality imports. Retain full frozen method surface, operand-order contract and raw-instruction escape semantics. Old paths re-export the same types.
6. **NEW `src/backend/wasmgc/lowering/type-converter.ts`**, only the actual TypeConverter declaration from `src/ir/backend/contract.ts:121–125` and required clean type imports. The original five-part public contract imports/re-exports it. Do not pull ModuleAssembler/emit/resolve-layout or compiler options into this small dependency. Do not redefine its generic default or make convertType a new completion permit.
7. **NEW `src/ir/analysis/nested-stackification.ts`**, actual `src/ir/nested-stackification.ts`, canonical effects/core only; old path re-exports. Preserve lexical scheduling and use accounting.
8. **NEW `src/backend/wasmgc/lowering/dynamic-scratch.ts`**, actual `src/ir/lowering-dynamic-scratch.ts`; **NEW `wasm-int32-coercion.ts`**, **`wasm-math-minmax.ts`**, **`wasm-constants.ts`** in the same directory from their exact current donors. Canonical instruction/type imports only. Preserve all number conversions, NaN/signed-zero behavior and raw instructions byte-for-byte.
9. **NEW `src/backend/wasmgc/lowering/generic.ts`**, the complete actual `src/ir/lower-generic.ts` body, with imports directed to the canonical contracts/legality/effects/error/tag mapping/date symbols/nested scheduling/scratch/string vocabulary/model modules above. Keep all exported utilities and private helpers, not only the methods reached by the 43 fixtures. This includes lowerIrFunctionBody, projectIrFunctionSignatureWithConverter, lowerIrTypeToValType, the exact signature guard, nested instruction scheduling, all try/loop/closure/string/vector/async/generator/dynamic branches and existing unsupported refusals. Keep current unit-specific source allocation resolver semantics. Do not import a concrete emitter or old `lower.ts`/Wasm wrapper back into the generic body. `src/ir/lower-generic.ts` becomes an explicit compatibility re-export only.
10. **NEW `src/backend/wasmgc/lowering/emitter.ts`**, actual `src/ir/backend/wasmgc-emitter.ts`, using the new canonical contracts/constants plus existing clean exception-control. Preserve every opcode/local/field operand and actual closure initializer operand emission. The current emitter's exact semantic delta history must be reconstructed from this real destination, not an old stub. Old path re-exports the actual class.
11. **NEW `src/backend/wasmgc/lowering/wasm-lowering.ts`**, actual `src/ir/backend/wasm-lowering.ts`: real Wasm converter, signature projection, flatten helpers and Wasm function assembly over the real generic lowerer/emitter. Old path re-exports. No callback substitutes for the lowerer.

This keeps `src/ir/backend/linear-emitter.ts` and the large linear planner outside the new WasmGC dependency closure without removing any linear behavior. They continue to import old compatibility contracts and obtain the same canonical declarations. Their own migration is not necessary for this root if E is implemented correctly. Generic lowerer support for existing bytecode/other sinks is retained through the compatibility export and its current tests; no claim is made that every backend's separate module closure is now clean.

### E. Preserve the source issuer; separate the real non-WasmGC compatibility branch

The frozen physical source owner currently imports both WasmGcEmitter and LinearEmitter because its donor `fillPreparedPrimaryUnit` also served generic program emission. That one branch must be actually separated, not hidden by a dynamic import.

Owner E owns `src/backend/wasmgc/program/native-source-invocation.ts`, `src/backend/wasmgc/resources/native-source-call-targets.ts`, and the compatibility dispatch in `src/ir/program-native-invocation.ts`, together with exact affected helper tests. Do not copy or recreate the private source WeakMap.

- The backend source owner imports the real clean full validator from C and real generic/WasmGC implementation from D. It remains the one owner of source units, allocation-owner associations, original slots, completed units, lowered body/local snapshots, all-source callable packs and call targets. Keep all full validation/currentness calls before reservation/binding/completion. Targets use the same validator.
- Keep the real WasmGC primary fill and source completion authority in the backend owner. It must instantiate the actual WasmGcEmitter and invoke the actual lowerIrFunctionBody using the retained function and exact resolver; freeze/audit original locals/body and mark completion only there.
- The old `src/ir/program-native-invocation.ts::fillPreparedPrimaryUnit` compatibility entry retains the current full call signature and dispatches WasmGC to that exact implementation. For non-WasmGC calls **without a source emission**, retain the existing real LinearEmitter/generic lowering/signature reconciliation/fill path in this mixed compatibility module (or an existing mixed implementation it already owns). This is real compatibility behavior, not a wrapper from a clean module back toward debt.
- A native source emission is already derived only from a standalone-WasmGC selected projection: `collectNativeStringValueDemands` lines 136–143 enforces it, and program-consumer selects source input only for that policy. A source pack plus another backend must refuse before publication, rather than consume the WasmGC owner through a linear emitter. Add a direct negative and preserve the actual ordinary linear no-source positive. If a successful non-WasmGC source-pack caller is discovered in the complete reader census, stop this split and specify its real separate source protocol instead of deleting it.
- No public function may accept a caller-supplied `loweredSuccessfully`, arbitrary lowering callback, emitted body hash, completion count or unauthenticated body/slot tuple to mint the source completion record. No old/new dual owner. Generic resolver callbacks remain the existing frozen lowering contract; they are not upgraded into authorization evidence.
- Preserve production call sites in program-consumer and test/helpers by old-path compatibility. Only newly clean roots should directly import the new implementation. End with exact identity tests between old/new public APIs and the one private issuer (begin via old path, bind/fill via new, complete via old and inverse).

Root's source parameter-copy repair is a prerequisite carried by normal integration, not repeated here. Source mode facts remain an independent specified requirement; no this/Construct/class behavior is inferred from missing metadata during this extraction.

## Reader/mutator inventory and private ownership

The machine-readable companion `extraction-analysis-readers.json` records incoming literal module edges from the writer's exact resolved import graph for the inspected donor set. It is a reader inventory, not a boundary run or a proof of every textual reference. Before edits, also search direct symbol imports/re-exports and test source readers for each moved symbol. Do not bulk rewrite all consumers: preserving old exports keeps the change to the actual clean closure.

Load-bearing mutable identities that must remain singular: source emission owners/units/completed/lowered/allocationOwners; source-target owners/tokens/filled state; ProgramAbiMap constructor and original inventory; prepared async attachment owners and canonical provider records; IrInvariantError/IrUnsupportedError/IrRuntimeFunctionPreparationError constructors; JS_TAG_DOMAIN; dominance cache; registry namespace mutations in analyses. For source owner, the actual writers are begin, bind, allocationResolver/fillPreparedPrimaryUnit and completion verification. Keep the same map and exact association path; no cross-module register-completion API.

## Historical receipt and gate blockers — exact affected instruments

These are identified from actual test code, not executed failures from this planning turn. Establish a pinned pre-extraction baseline and preserve its existing failures separately. Existing strict source-target 43/43 evidence does not measure these older instruments.

1. **`tests/issue-3518-lowering-relocation-coverage.test.ts` + `scripts/check-pushraw.mjs` + `scripts/pushraw-baseline.json`.** The gate hardcodes FIVE original paths (lower facade, lower-generic, lower-contracts, wasm-constants, wasm-lowering). Moving actual pushRaw sites without extending its real source population would disconnect it. Root must add the real canonical destination paths while retaining old-path duplicate/injection detection. Carry every old occurrence/tag exactly once through a proven path move; no numerical debt reduction from relocation, no duplicate credit for facade plus implementation. Test new untagged sites in every new path, removed/renamed/replaced old sites at equal counts, missing implementation, duplicate forwarding, and changed own-base source. Existing initial relocation body receipts and issue-budget grants remain intact; append a second exact relocation proof rather than rewriting those historical receipts.
2. **`tests/issue-3518-lowering-cycle.test.ts`.** Its runtime import assertions and bounded valueClosure start at the old generic path and explicitly forbid old lower/Wasm/emitter paths. Extend the graph control to canonical actual roots; a facade-only graph is not a positive. Keep aliases identity-equal, real Wasm and Bytecode execution controls, and mutations that import the actual new concrete emitter into generic. Type-only boundary checks belong to the unchanged exhaustive compiler-boundary detector too.
3. **`tests/issue-3518-native-string-no-demand-emitter-forward.test.ts` + `tests/helpers/native-string-no-demand-emitter-forward.mjs` + `tests/issue-3518-native-string-no-demand-preservation.mjs`.** The forwarding proof reads the live old emitter path, requires the exact import pair and nullability repair, and hashes complete historical before/after/repaired/candidate sources. A facade cannot satisfy it. Add an authenticated outer relocation input that reconstructs the prior live emitter from its REAL canonical implementation and exact import changes, then feed the unchanged historical verifier. Keep the older string/vector/state evolution order; never use existence fallback or check a saved historical file instead of current production. Preserve all existing hashes. Baseline any pre-existing live-source divergence before attributing it to this move.
4. **`tests/issue-3518-program-data-contract-seam.test.ts`.** It pins retained declarations/statements/docs from outcomes.ts and program.ts (including a 560-statement / 374-function historical retained total), plus exact destination populations. Moving exceptions or preparedIrProgramOwner needs an explicit current-to-prior source/declaration reconstruction before the existing checks. Keep old hashes/counts and original declarations/types. Do not append unrelated runtime values into the currently fixed type-only program/index facade.
5. **`tests/issue-3518-program-ownership-runtime-seam.test.ts`.** Its exact authenticated evolution already composes program.ts/data/input changes and authenticates current full hashes. Moving the real owner function changes the outermost current program.ts. Add one reviewed outer relocation composition before its existing inverse history; keep all prior current/intermediate hashes and original receipts. Retain the live import test for the actual validator path rather than testing an artificially normalized import as current production. Distinguish the historical parser view from raw source.
6. **`tests/issue-3518-core-vocabulary-seam.test.ts`.** It pins 31 retained string-runtime declarations and 32 retained counted-string-provenance declarations in addition to the previously moved vocabulary/type definitions. Moving the remaining semantic/grammar bodies needs relocation-aware current input which restores exact prior order/doc/body population, not new expected hashes. Do not move AST proof construction into the shared grammar leaf or remove its previous malformed/currentness/unique-site controls.
7. **`tests/issue-3518-runtime-data-contract-seam.test.ts`, `tests/issue-3518-provider-verification-ownership.test.ts`, `tests/issue-3518-historical-runtime-reconstruction.test.ts`, `tests/helpers/ir-historical-runtime-reconstruction.ts`.** The runtime reconstruction helper pins source-qualified owner order, overload occurrences and current hashes for intrinsic-support.ts and runtime-program-manifest.ts, including multiple clock/provider evolution stages. Relocate actual bodies first, authenticate new+facade bytes, then reconstruct the former live owner BEFORE the existing historical transformations. Do not change registry contents or historical provider receipts.
8. **`tests/helpers/semantic-provider-source-receipts.mjs` and `scripts/lib/frame-delay-three-arm-contract.mjs`** use explicit current/historical paths for demands/support/program. Preserve their separate arms and actual executed candidate source path. A compatibility re-export preserves dynamic API callers, but source inspection must explicitly follow the new real owner via a fixed tested mapping. No generic symbol search or optional path fallback. `tests/issue-3521-program-runtime-demands.test.ts` also reads source and must keep its current demand-owner assertions meaningful.
9. **`tests/issue-3518-program-data-contract-boundary.test.ts`, compiler boundary tests, LOC/function budgets, JsTag/dead-export inventories.** Keep original activated roots, floors, historical evidence and all allowed edges. Add real new leaves/paths only after their closure is clean. Budget transfer for the ~4,200-line generic body must be exact and single-owned; retain no duplicate old/new allowance or growth grant. JsTag sites must follow the actual relocated domain/handle owners; do not erase them from census by moving paths. Root owns these metadata/gate changes, after a source manifest is frozen.

For each preservation evolution: authenticate full actual old/new source blobs and SHA-256, exact facade exports and moved declaration counts/order/docs/bodies, approved import substitutions only, and reciprocal reconstruction. Apply once to the initial LIVE input, before older inverses. Never normalize a caller's already-mutated injected source again. Add paired mutation controls for deleted/duplicated/moved/renamed definitions, changed bodies/readonly/optional fields, wrong imports or import kind, extra top-level declaration, missing destination, wrong prior/current blob and unrelated byte changes. Preserve raw original failing logs and all old signed receipt identities. No historical checkout fallback, baseline hash refresh, wildcard source finder, skip/todo, or widened semantic admission.

## Validation acceptance for the implementer/root (not run here)

1. Pin all pre-extraction production/test/gate inputs; record the existing historical failures before repair. Run TS7 and exact source-target 43 controls on the actual integrated tree. Preserve zero skipped/setup-blocked rows and all new wrong-header/identity/slot/foreign-ledger/currentness guards. Retain all earlier run evidence.
2. Add exact old/new identity tests for moved classes/functions, canonical registry and source pack; constructed errors retain instanceof/cause across both import paths. Keep existing non-JS domain tests (`issue-3954-phase3-nonjs-domain`, tag-domain), declared-type verifier rules, dominance tests, fnctor ABI tests and backend-contract tests.
3. Full genuine prepared-program and decoded validation must reject each check family above: altered/dropped/reordered unit; duplicated/contradictory ABI; wrong call/global/closure signature; Promise/body mismatch; stale allocation alias/metadata; missing support dependency/forged physical field; class layout mismatch/accessor; bad startup/export storage; wrong runtime policy/provider/population/clock projection; own undefined support; invalid instruction/dominance. Use the same source-independent validator for original and decoded packets; no synthetic registry or sealed-packet admission override.
4. Preserve `issue-3521-whole-program-validation`, population, projections, prepared-ir-program, runtime-demands, `issue-3518-runtime-producers`, source closure requirements and existing actual source call/apply/getter/throw/replay cohorts. Verify exact body/local equality and original emitted bytes where the extraction is behavior-neutral.
5. Generic lowering stays callable via old API and actual canonical implementation. Run existing generic/Wasm/linear/bytecode controls, real source closure allocation/capture lowering, displaced index spaces, actual signature/ref.func/nullability, error identity and repeated fresh instances. Add a genuine no-source linear program through the compatibility primary fill and a native source pack + linear mismatch refusal before any fill. The new clean backend root must not import LinearEmitter.
6. Run all affected historical tests after adding the bounded outer relocation proof. Preserve original counts and guard negatives. Attribute failures from exact rows and unchanged input hashes, not suite-size inference.
7. Exhaustive inventory must be valid, with all new real roots visited and both type/value closure free of frontend/mixed/legacy imports. Complete mode must still report the actual remaining architecture debt. Add detector mutations at new roots for a direct mixed validator import, type-only target-profile/linear planner import, concrete emitter back-edge into generic, exported barrel to debt, and missing real implementation. Do not alter allowed edges to accept any mutation.

## Boundaries deliberately not expanded

Do not relocate all of program.ts, program-abi.ts, prepared-component-dependencies.ts, AST lowering plans, target-profile, the linear planner or legacy codegen. The plan extracts only the actual bodies/declaration closures needed by these roots and keeps their old callers compatible. Do not change the canonical provider catalogs, fabricate source modes, or register Number prematurely. Do not edit root's three parameter-copy files. Runtime/source behavior additions continue under the separately held public graph work after this architectural prerequisite is complete.

The remaining global compiler closure FAIL is honest. An inventory-invalid source-owner relocation is not a releasable substitute for this prerequisite.

## Static evidence and source pins

No compiler, test, boundary gate or Git mutation was run for this analysis. The pinned source-reader appendix is evidence of inspected dependencies, not execution. Input pins: `.tmp/mixed-invocation/extraction-analysis-pins.json`; reader graph: `.tmp/mixed-invocation/extraction-analysis-readers.json`.

68 inspected input files were pinned before writing this spec; re-read drift: 0.

```json
{
  "pins": {
    "scripts/check-compiler-boundaries.mjs": {
      "sha256": "8f3d5bf42c1ef6345483cfa1ac45832b4d6f31c9bd4086074505dbda741afc05",
      "bytes": 31521
    },
    "scripts/compiler-boundaries.json": {
      "sha256": "af4c023a432063e4c8211b842862d9a51fd064220e300201dce037c8532c04cc",
      "bytes": 560838
    },
    "src/backend/wasmgc/program/native-source-invocation.ts": {
      "sha256": "0805e2354dc4ac02708b9a83ec7b90eb7b4cfc7b7dbda37975aca8dd7846dc5a",
      "bytes": 17847
    },
    "src/backend/wasmgc/resources/native-source-call-targets.ts": {
      "sha256": "622e138f16a4f7e2300ed9af293a5e9e21ea4e4ee3bd3b4acfa71ecf40799793",
      "bytes": 11042
    },
    "src/backend/wasmgc/resources/native-source-closures.ts": {
      "sha256": "c5bd42e9b96e15323859fe89af45c241c2b05e0e26c3da6c671428297656803f",
      "bytes": 22434
    },
    "src/ir/program-native-invocation.ts": {
      "sha256": "fc068dbfb238f44d90b360dd1ecc4e70c2f2f11b1b2a28aeaa3f08d8e059dc2f",
      "bytes": 1477
    },
    "src/ir/program-validation.ts": {
      "sha256": "816c404e96f8e9a5782d5c51714f0aec0592967bb13f1e09ca50f3f29c2c3299",
      "bytes": 19427
    },
    "src/ir/program-runtime-validation.ts": {
      "sha256": "bb4006f9bcdf641f665b6b1ee10ea6fd8ced30e168d09faf8439358d574f2b0c",
      "bytes": 8186
    },
    "src/ir/program-runtime-abi.ts": {
      "sha256": "0f8eb92a65a87a4fe0275aa4e90f88a600f3f598f9278fd01edd198fff4c41a4",
      "bytes": 4475
    },
    "src/ir/runtime-program-manifest.ts": {
      "sha256": "d9698e66ad1d048e51dd58f6a5b47b2adf65a61da1787c5d543b1ac6437036a9",
      "bytes": 12069
    },
    "src/ir/program-runtime-demands.ts": {
      "sha256": "e3b2d8e2adc4dbee309050dd9085ef710949422e1b94789cdc3138b1737caf32",
      "bytes": 13421
    },
    "src/ir/intrinsic-support.ts": {
      "sha256": "03e5d583b91a7589481c80e1ca1dd5a621fee3e593f5ca9537f9c573b8925e40",
      "bytes": 49626
    },
    "src/ir/program-allocations.ts": {
      "sha256": "bd7e82e46bfaf26bdcdf5759ef70b18b2ae1e74120039054f0f0aaf764dfb57c",
      "bytes": 6549
    },
    "src/ir/program-class-layouts.ts": {
      "sha256": "010ecc8d4ee03087bb0faac9d10c7f183fe50b07f3445ee7631756088fd81251",
      "bytes": 2620
    },
    "src/ir/prepared-component-dependencies.ts": {
      "sha256": "0ea7a1b7d7ce5bf0a035d8b3a4c9c5a65aabd841ddd3c7a7c10bf82b11c9b8a7",
      "bytes": 74563
    },
    "src/ir/program.ts": {
      "sha256": "3df8deb9d3647466c2381957aa22410c593057cbdd855007b1279ebd755a5510",
      "bytes": 21542
    },
    "src/ir/program-abi-contracts.ts": {
      "sha256": "855ce794bc57f152a564c388b0d0c5de3ae056d4382c097fc3182c0a68343fda",
      "bytes": 11056
    },
    "src/ir/abi-bindings.ts": {
      "sha256": "66ed6871b28bad9610053cb56ac30a3bbd99abb6a28e55b87f83a1e0c43cc65b",
      "bytes": 12506
    },
    "src/ir/verify.ts": {
      "sha256": "990ab03c38f460ee801a87224c60106d4f63a6d5367e9b742c1fd1763fa67100",
      "bytes": 122223
    },
    "src/ir/verify-alloc.ts": {
      "sha256": "40161d406e9d322c2681617dbc2bcf178e8be21bdac4c1448f7c7b3eec10ee84",
      "bytes": 7023
    },
    "src/ir/declared-types.ts": {
      "sha256": "d3f0575647d597c6a5f3f309e9da1d3dccf640756b524c2f6fade3a5f17118e3",
      "bytes": 7022
    },
    "src/ir/fnctor-abi.ts": {
      "sha256": "e72be1d68751ec3554a71937c95628459d1cc1be6a38b6afb484c5c6e7227dbe",
      "bytes": 12964
    },
    "src/ir/producer.ts": {
      "sha256": "655233a5ac2a8a8c975e1eebe948524daeeb7a1281f5c743f7e8bb2ab2ae2032",
      "bytes": 2642
    },
    "src/ir/tag-domain.ts": {
      "sha256": "4fc990305f5e6e3da738e8750caa32c27244098ef599d9f60e276ca712da24d8",
      "bytes": 11318
    },
    "src/ir/js-tag-domain.ts": {
      "sha256": "46623e973ed0450476d648ae6931612c0b1cd9b63e8ed1decf48a6cded3d2fc5",
      "bytes": 13570
    },
    "src/ir/outcomes.ts": {
      "sha256": "d2d6e6ca0603e936901f31d875cb6474748f56b42b2e398e6cccedf0f25256be",
      "bytes": 12354
    },
    "src/ir/string-runtime.ts": {
      "sha256": "647e05b78186d63ab65bc2047500cc8a6e23102a408c1506e81c4a92b6861748",
      "bytes": 7621
    },
    "src/ir/date-runtime.ts": {
      "sha256": "a78f87a50815e36c24509b63ef8d1fba4e58725bbd069d85460c523a727893f0",
      "bytes": 724
    },
    "src/ir/ast-lowering-plans.ts": {
      "sha256": "23fe4760963926f2666fae5388fc623b6a664a903e2cb21264c25694090b1580",
      "bytes": 19035
    },
    "src/ir/runtime-symbols.ts": {
      "sha256": "840622cc672ccb7a0e7ccb5bc5e7e5e5846205a837a12637835424fa244bd6e1",
      "bytes": 418
    },
    "src/ir/generator-support.ts": {
      "sha256": "fbc2d0cb9837ca7a55ac1dc6cef62b0f51a91ccf41a5c4a09c1854599f07a01f",
      "bytes": 8816
    },
    "src/ir/counted-string-append-provenance.ts": {
      "sha256": "a0d595166b0a209e17d6b2b59caf66f4a30e9f2d4b17051d14cda07cc57b4d0e",
      "bytes": 17037
    },
    "src/string-surrogate.ts": {
      "sha256": "782969df8b156eec18455d8e7f33acd1902cfa1b8d1e3f2e94dbb494a5ff49a4",
      "bytes": 2435
    },
    "src/ir/analysis/dominance.ts": {
      "sha256": "dd951d008a605614fb7e8eee4e8d148112f438b9a954d75197a6da6d6b50a820",
      "bytes": 13729
    },
    "src/ir/analysis/ownership.ts": {
      "sha256": "e591418b5044f844dd37562471d249aa116846e30f0a23cdde1b3e51d4640051",
      "bytes": 23651
    },
    "src/ir/analysis/escape.ts": {
      "sha256": "8292ac767cb3f1f9ea89de4a7a4e1b7f68be8f2a78ac12c92a67ea0d2f614444",
      "bytes": 10826
    },
    "src/ir/analysis/encoding.ts": {
      "sha256": "02502ab1f7a254253a830a1c4bbacfc27900f6d34aa0a43eb4030d50d3bcdf11",
      "bytes": 10318
    },
    "src/ir/analysis/lattice.ts": {
      "sha256": "8814ff9b71c04e9e16760a913984aaba60f23b402a700968fd6c2a70c92fc22c",
      "bytes": 5739
    },
    "src/ir/analysis/linear-memory-plan.ts": {
      "sha256": "382cb4acee2de86904da1c0162ecc8b9de4250f9f9cb49dcba57b1a056c1cc3c",
      "bytes": 52704
    },
    "src/ir/lower-generic.ts": {
      "sha256": "7d3c2f960871809934e664d46947b61d7edd86957f086248b566953f9848bb14",
      "bytes": 196934
    },
    "src/ir/backend/contract.ts": {
      "sha256": "075641a3808cddd9e186165b6740db0f18ef27995120b7b981c3e0a4c7c1467d",
      "bytes": 16774
    },
    "src/ir/backend/lower-contracts.ts": {
      "sha256": "a37d6a53a62d32f31d6fdda22eecc44b28a0c8a12e0e4b146c8d3dd212b1c23c",
      "bytes": 14193
    },
    "src/ir/backend/handles.ts": {
      "sha256": "f6e3f9516befb445947bad64a2f0b023e5f5592e385f04e282eb0848f12e0453",
      "bytes": 22904
    },
    "src/ir/backend/emitter.ts": {
      "sha256": "1b66b428e7c172d509753b54c3e244eebfd035a0c3f5c66fc391673c70eabb19",
      "bytes": 18048
    },
    "src/ir/backend/string-contract.ts": {
      "sha256": "daacef88c2bad2e91b4b21eed47b9b900decfca9fdddcb4eff88e900eed22527",
      "bytes": 1429
    },
    "src/ir/backend/legality.ts": {
      "sha256": "6a64764b2691d6b2994258a966afabdac0b981fc036f611be5d8969032a3db98",
      "bytes": 26410
    },
    "src/ir/backend/wasmgc-emitter.ts": {
      "sha256": "e1f086482c649e6a1fc1d58f11132c458668155250503e508a17332d143d6c5b",
      "bytes": 20464
    },
    "src/ir/backend/linear-emitter.ts": {
      "sha256": "dda316ded6fd9e08bd530e6f743000850a064d950a62dbd9506e5313c8b21041",
      "bytes": 21857
    },
    "src/ir/backend/wasm-lowering.ts": {
      "sha256": "143e867a3a50039aa8192c4733b7a5eaf50916c4fdefedf3fe9d635913a8550a",
      "bytes": 3266
    },
    "src/ir/backend/wasm-constants.ts": {
      "sha256": "80a2149c4a3ce9011e5150794cc7218dfa0f45fa47ab21b87fd80d2242585c54",
      "bytes": 1179
    },
    "src/ir/backend/wasm-int32-coercion.ts": {
      "sha256": "23cf996416285cf8495c2c6977396c9c81eaf2af79d8c15f1c8d6ef6f05da2a0",
      "bytes": 3778
    },
    "src/ir/backend/wasm-math-minmax.ts": {
      "sha256": "76a3e201e5ed64e768963facfd87fdaedba31b0bcbd3b73300eb647237c4f822",
      "bytes": 1664
    },
    "src/ir/nested-stackification.ts": {
      "sha256": "f66f42492cb6aaf0c55ad3681289802c1e598ea98119edc975bd37618c905a33",
      "bytes": 3570
    },
    "src/ir/lowering-dynamic-scratch.ts": {
      "sha256": "e70eaec584d4fca7d2d17f9ce496536626e7fb287cd018c91705ca12f6b5d609",
      "bytes": 1346
    },
    "src/ir/try-table.ts": {
      "sha256": "60c4f8f6a4c4ce046b874638392d3892d4c434d77aac462c5e7c4703a9d914b9",
      "bytes": 266
    },
    "src/ir/program-consumer.ts": {
      "sha256": "1aa39c518fa1e1a3203711ce521f36ad9468453f173560fa2e018fc9fd025ca9",
      "bytes": 68143
    },
    "scripts/check-pushraw.mjs": {
      "sha256": "c11175c9513ec8c6c5d2cf608b2f99bf265a441b90c81c46811e0d871c5d3bf7",
      "bytes": 11282
    },
    "scripts/pushraw-baseline.json": {
      "sha256": "b543c5fa111bd04e9ab1f8f55bde8aae2710dfa6a056f11b99c9674f5381d259",
      "bytes": 346
    },
    "tests/issue-3518-lowering-cycle.test.ts": {
      "sha256": "b489161dc18badbb995ebc0133b3d8d61967ab12bba5bb5ccb1732d67cd7ae72",
      "bytes": 20869
    },
    "tests/issue-3518-lowering-relocation-coverage.test.ts": {
      "sha256": "87083dc88583b80bfa025e13c8a632dcc1280804b9c525ba493493f7a4dcc8f0",
      "bytes": 9822
    },
    "tests/issue-3518-program-data-contract-seam.test.ts": {
      "sha256": "f5a9447ff2cc8cd3363c3d1c070c317e70a92d5f86146cfd795a04bad6921c41",
      "bytes": 34377
    },
    "tests/issue-3518-program-ownership-runtime-seam.test.ts": {
      "sha256": "59490fb80f716b464144814c10416eae9cf0c150f16cf1a522c923abcbdbd85c",
      "bytes": 42883
    },
    "tests/issue-3518-core-vocabulary-seam.test.ts": {
      "sha256": "c567bd3d822f4ffc27c6aa8f4cae4f50655d88c09a7b788cf915a008930ff249",
      "bytes": 18544
    },
    "tests/issue-3518-runtime-data-contract-seam.test.ts": {
      "sha256": "8d32a071b57435f7d08d6101f1448d4779ac8edcab31b8d8f671a7b138f4bd52",
      "bytes": 44714
    },
    "tests/helpers/ir-historical-runtime-reconstruction.ts": {
      "sha256": "114a21cb1bc05bfe64045a12f8fa5474a729284f442afc4c155234bc3e08aafc",
      "bytes": 108057
    },
    "tests/helpers/semantic-provider-source-receipts.mjs": {
      "sha256": "83e8424be0406fb84b81e72496b5602362d4ff20687f27f0d234ce180f0f9093",
      "bytes": 55266
    },
    "tests/helpers/native-string-no-demand-emitter-forward.mjs": {
      "sha256": "b8a13309559ffabbf67d820fa543d4023ee639b214262e8f6687f129942b71b4",
      "bytes": 3744
    },
    "tests/issue-3518-native-string-no-demand-emitter-forward.test.ts": {
      "sha256": "ad4ffb7e18aa25781e1ff8f86d4a96f30a15e5175d612a4307dcb0aca06769d8",
      "bytes": 5910
    }
  },
  "drift": []
}
```
