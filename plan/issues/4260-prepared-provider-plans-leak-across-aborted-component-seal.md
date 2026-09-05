---
id: 4260
title: "Prepared callable-provider plans leak across an aborted component seal"
status: done
sprint: Backlog
created: 2026-08-09
updated: 2026-08-27
priority: medium
horizon: m
feasibility: hard
reasoning_effort: high
task_type: bug
area: ir, program-abi
language_feature: compiler-internals
es_edition: n/a
goal: full-conformance
parent: 3521
related: [3520, 3521, 3522, 4259]
origin: "2026-08-09 #4259 injected prepared-component seal failure: a TDZ setter plans __new_ReferenceError before its component transaction, then abort cannot retract that provider/import publication"
---

# #4260 — Make prepared provider planning transactional with component sealing

## Root cause

#4259 added an injected failure immediately before a prepared class-accessor
component seals. With a `let` writeback, the IR TDZ guard depends on
`__new_ReferenceError`. The focused failure revealed that
`planBlockingCallableProviders` publishes the provider and its import/in-module
implementation through global `planPrepared` state **before** the component
opens and seals its scoped Program-ABI transaction.

If that component later aborts, `scope.abort()` retracts only the component's
borrowed bindings. It cannot retract the already-published provider plan. The
fallback path then observes one of two invalid states:

- host/GC: dead-code cleanup removes a provider that the sealed registry still
  considers published (`removed after ABI scope sealed`); or
- standalone: direct fallback rematerializes the dependency after the failed
  prepared plan and reports the provider as unplanned.

This is not an accessor or `ReferenceError` special case. Any blocking runtime
callable provider discovered solely by a component that later aborts can leak
the same global reservation. Retaining an unused host import or suppressing the
registry invariant would hide the split rather than restore transactionality.

## Implementation boundary

1. Stage callable-provider and corresponding import/in-module provider plans in
   the same provisional component transaction as their consumer bindings.
2. Publish those plans only when the component seal succeeds. On abort, publish
   none of them and leave the transitional direct path free to plan its own
   actual dependencies.
3. Preserve deduplication when multiple components request the same provider:
   one failed consumer must not retract a provider already committed by a
   healthy component, and one healthy consumer must not make a failed
   component appear sealed.
4. Keep host imports and standalone/WASI in-module constructors behind the same
   Program-ABI provider identity. Do not add a `__new_ReferenceError`-specific
   cleanup path.

## Acceptance criteria

- [x] An injected pre-seal failure over a TDZ-writing prepared component records
      typed Unsupported and executes only direct codegen (`direct=1, IR=0`) in
      GC and standalone, without stale-provider, unplanned-provider, or
      post-claim errors.
- [x] The aborted host component leaves no unused `__new_ReferenceError` import;
      the aborted standalone component leaves no orphan in-module constructor.
- [x] A two-component control where both request the same provider and only one
      aborts proves that the healthy component remains sealed/emitted and owns
      the single committed provider plan.
- [x] Provider/import planning, prepared-component dependency, Program-ABI
      transaction, direct-fallback, typecheck, and IR fallback suites pass.

## Relationship to #4259

#4259 keeps its seal-failure regression focused on compile-once body ownership
with a `var` writeback, while a separate TDZ test proves the successfully sealed
`ReferenceError` path. This issue owns the newly exposed cross-transaction
provider leak; #4259 must not claim that leak as fixed.

## Current-main implementation plan (2026-08-25)

The current defect is earlier than the scope transaction. In
`sealDependencyCompletePreparedComponents`, the dependency fixed point calls
the callable-import and callable-provider registries before
`beginPreparedComponentScope`. Both `planPrepared` methods immediately publish
compilation-wide state. The later `abort()` closes only the open scope ID, so it
cannot retract the import denominator, provider order, registry mappings, or
the Program-ABI drafts, locators, structural references, and callable
contracts those methods already installed.

Land this repair in two implementation PRs after this issue-plan amendment.
The first PR freezes a side-effect-free description boundary without changing
production behavior. The second makes one prepared component transaction own
description, dependency lookup, validation, and publication. Do not combine
the checkpoints: the descriptor seam is independently reviewable and gives the
behavioral PR a small, exact atomic-commit surface.

### A. Behavior-neutral prepared-plan descriptors

Limit the first implementation PR to:

- `src/codegen/program-abi-import-planning.ts`;
- `src/codegen/program-abi-provider-planning.ts`;
- `tests/issue-3520-program-abi-import-callable-planning.test.ts`; and
- `tests/issue-3520-callable-provider-abi.test.ts`.

1. **Immutable import description.** Add one module-private, opaque
   prepared-import descriptor and a public registry
   `describePrepared(values)` operation used by the compatibility wrapper. A
   descriptor freezes the exact current registry denominator: the prospective
   sorted live population only while unsealed, otherwise the existing
   `sealedEntries`. It retains object identity, canonical structural key,
   population ordinal, projected
   `IrBindingId`, structured signature, exact locator, draft, structural
   reference, and type contract for every selected import. Duplicate allocator
   objects, values outside the population, malformed signatures, an
   already-finalized retained catalog, and key/ordinal collisions fail before a
   descriptor is returned.

2. **Immutable provider description.** Add the corresponding module-private
   prepared-provider descriptor and public registry
   `describePrepared(keys, exactImportDescriptor?)` operation. Accept an exact
   optional import descriptor object, never a caller-supplied owner map. It
   freezes the exact canonical provider order: the complete sorted prefix
   before first seal, or that immutable prefix plus the discovery-ordered
   appended suffix afterwards. It retains the selected key set, same-locator
   closure, exact locator objects, population ordinals, projected
   binding IDs, signatures, the canonical owner and alias rows for every same-
   locator provider group, and whether each provider aliases an exact committed
   import/source/support/provider locator owner, the first owner in the same
   provider batch, or an import owner supplied by that descriptor. A defined or
   already-owned provider needs no import descriptor. An unowned import locator
   requires its exact import descriptor and must never become provider-owned.

3. **Description has zero publication effects.** Calling either descriptor
   operation must not change `sealedEntries`, `observationOrder`,
   `appendedOrder`, `plannedByImport`, `plannedByKey`, `plannedValue`, or any
   `ProgramAbiSession` draft/contract/reference/locator map. Previewing a
   provider must not make a later `observe` append instead of sort. Previewing
   an import must not make later DCE use a prepared denominator. Deep-freeze
   descriptor-owned record and array/tuple clones while retaining, but never
   freezing, exact allocator-owned `Import`, `WasmFunction`, signature/type,
   and locator object references. Use frozen arrays/tuples or an immutable
   wrapper; `Object.freeze(new Map/Set)` is not immutable and must not be
   exposed. Do not expose a mutable registry map or use a test import as a fake
   production consumer.

4. **Fail-closed currentness before publication.** Add internal descriptor
   validation that reconstructs those state-aware import/provider denominators
   and checks exact object, key, ordinal, locator, signature, same-locator
   closure, alias owner, and session state equality. A stale descriptor
   publishes nothing.
   Compare only touched IDs/order slots/keys/allocators/alias closure: unrelated
   session drafts and layouts may legitimately appear. Never compare transient
   numeric function indices. The later transaction will call this preflight
   before any `Map.set`; the first checkpoint exercises it through the
   compatibility wrapper.

5. **Compatibility wrapper preserves behavior.** Keep `planPrepared` as
   `describePrepared` followed by the existing immediate publication path.
   Existing callers, returned provider maps, post-DCE sparse import identities,
   late-provider append semantics, and final ABI bytes must remain unchanged.
   Preserve the asymmetric compatibility edges: import `planPrepared(empty)`
   is a no-op; provider `planPrepared(empty)` seals the observation order; and
   provider calls after `plannedValue` reuse exact committed mappings.
   This checkpoint must not edit prepared-component sealing, the scope
   transaction, environment switches, issue inventories, or runtime fixtures.
   Do not export a descriptor type solely for tests or add a dead-export
   baseline row; promote only the exact type surface consumed by production in
   checkpoint B.

6. **Non-vacuous descriptor tests.** Extend the two existing focused suites
   with positive controls and one-fact mutations for an out-of-population
   import/provider, duplicate allocator object, semantic denominator drift,
   removed or replaced locator, changed type index/signature, changed
   structural key, same-locator sibling drift, missing/changed provisional
   import alias owner, and retained-planning closure. Snapshot registry/session
   cardinalities before and after every description call. Reordering unique
   exact import objects while keys, objects, provenance, and
   contracts remain identical is a positive index-shift control; changing a
   duplicate group's canonical key ownership rejects. A sealed-import
   descriptor must retain its existing sparse denominator, and an appended-
   provider positive must retain prefix-plus-discovery order; re-sorting or
   reordering that suffix rejects. Explicitly prove that a
   lexically earlier provider observed after an abandoned preview receives the
   same ordinal as an unpreviewed control and that import removal after an
   abandoned preview is accepted exactly as in the unpreviewed control.
   Publishing that now-stale descriptor still rejects without a write.

The descriptor PR is behavior-neutral. Its review must compare final
`planPrepared` output and ABI publication against a pre-checkpoint control, not
merely assert that the new helper returns a value.

### B. Atomic prepared-component publication

Limit the behavioral PR initially to:

- `src/codegen/program-abi-session.ts`;
- the two descriptor registries above;
- `src/codegen/program-abi-type-planning.ts` for provisional class layouts;
- `src/codegen/program-abi-export-planning.ts` for provisional public aliases
  of exact provider targets under B1;
- `src/ir/prepared-component-sealing.ts`;
- `src/ir/integration-report.ts` and the one callback consumer in
  `src/ir/integration.ts` under the reporting exception below;
- `src/codegen/ir-overlay-outcomes.ts` only for the matching terminal-evidence
  audit rule below;
- a new `tests/issue-4260-prepared-provider-transaction.test.ts`; and
- only the existing focused Program-ABI/session/provider/import/type tests
  required by a shared API change, plus the exact #4588 **Prepare the compiler
  timer shim through exact IR ownership** exported-provider control.

Do not move provider allocation or observation in `src/ir/integration.ts`.
Those allocator objects may be created before component sealing; the bug is
premature ABI publication, not materialization. Keeping `integration.ts`
free of provider-planning changes keeps this issue disjoint from #3518 and the
linked-parser work. The sole authorized edit there is the typed reporting
consumer below.

#### B0. Exact pre-publication injection reporting seam (2026-08-26)

The original “keep `integration.ts` untouched” lock conflicts with the literal
GC/standalone acceptance above. `sealDependencyCompletePreparedComponents`
currently sends every aborted terminal through one `onSealFailure` callback;
that callback calls `markOwnerFailure`, whose `IrIntegrationFailureLog.record`
necessarily adds a public `report.errors` row. `consumeIrOverlayReport` then
copies that row into `CompileResult.irPostClaimErrors`. The exact injected
pre-seal control can therefore produce the required typed Unsupported outcome
or zero public post-claim rows, but not both, without a narrow reporting seam.

Keep the zero-row requirement literal and add that seam as follows:

1. Extend the prepared-component failure callback/result with a typed
   diagnostic-visibility discriminator. It is `"outcome-only"` **only** for a
   component selected by the already parsed, uniquely matched
   `JS2WASM_TEST_INJECT_IR_PREPARED_SEAL_FAILURE` selector and aborted before
   descriptor publication begins. Every real dependency, descriptor,
   currentness, overlay, validation, or ordinary seal failure remains
   `"report"`.
2. Derive the discriminator from the validated selector/component identity at
   the injection site. Never infer it from an error message, code, provider
   name, terminal display name, or catch-site type. Invalid, unmatched, or
   multiply matched selectors remain invariants and cannot request silence.
3. Add `IrIntegrationFailureLog.recordOutcomeOnly` (or the repository-equivalent
   exact method). Give each terminal failure event and its projected failed
   terminal evidence an explicit `diagnosticVisibility: "report" |
   "outcome-only"`; never infer visibility from an empty `errors` array. The
   new method records one `"outcome-only"` event with the same typed
   `IrIntegrationError` representative used by normal reporting, but with an
   empty public-detail list and without inserting into `errors`. Normal
   `record` and verifier groups remain `"report"`. This retains exact failed
   terminal evidence for outcome reconciliation while leaving
   `IrIntegrationReport.errors` and `CompileResult.irPostClaimErrors` empty.
   Both paths must reject a mismatched owner/label exactly as `record` does.
4. The narrow `integration.ts` callback branches only on that discriminator:
   both arms add the terminal to the same failed-owner set, normal reporting
   calls `record`, and outcome-only reporting calls `recordOutcomeOnly`.
   Selection, body construction, provider allocation/observation, dependency
   derivation, slot ownership, direct fallback, and lowering are unchanged.
5. Teach `auditIrIntegrationTerminalEvidence` the same exact discriminator.
   An `errors: []` event is valid only when it is explicitly
   `"outcome-only"` and its representative is
   `unsupported/late-preparation-unsupported@resolve`; the owner pair and all
   remaining terminal-evidence invariants still apply. A `"report"` event with
   no public error, an `"outcome-only"` event with any public error, a wrong
   representative kind/code/stage, or an unknown/malformed visibility is an
   invariant. Do not weaken public-error object coverage for ordinary failures
   or let a forged empty array request silence. This is the only authorized
   `ir-overlay-outcomes.ts` change.
6. The outcome-only event remains
   `unsupported/late-preparation-unsupported@resolve`, carries no
   `preparedComponentId`, and must reconcile to `direct=1, IR=0`. It is not an
   emitted/Prepared success and it is not omitted evidence merely because its
   public diagnostic list is empty.

Add paired controls. The exact injected selector must produce the typed
terminal Unsupported evidence and zero `report.errors`/
`irPostClaimErrors` in GC and standalone. A genuine non-injected descriptor,
dependency, overlay, or seal validation failure must still produce its existing
public diagnostic row. Mutate the visibility value, selector identity, terminal
owner, representative label, representative outcome code/stage, and empty vs
nonempty event-detail list; each mismatch must fail closed without publishing a
provider batch or silently dropping an ordinary failure. Keep #4259's existing
injection behavior compatible, but do not weaken its outcome, compile-once, or
runtime assertions.

#### B1. Export aliases join the same provisional provider batch (2026-08-26)

The broader #4588 **Prepare the compiler timer shim through exact IR ownership**
control exposes one more member of the same atomic publication boundary. Its
exported numeric helper can be first materialized by a provisional callable
provider. Before that provider commits, `planPreparedNumericPromiseAliases`
cannot find a committed locator owner and silently plans no alias. After the
provider scope seals, final `ProgramAbiExportRegistry.planRetained()` can find
the owner, but correctly rejects adding the export alias because that draft
would mutate the sealed prepared scope. Do not permit that late alias and do not
weaken `preparedScopeAffectedByDraft`; the alias belongs in the provider's
original transaction.

1. Add a registry-authenticated, side-effect-free prepared export-alias
   descriptor. It captures each selected value export's exact module row,
   ordinal, external name, `func`/`global` kind and index, resolved allocator
   object, expected target intent, entry-source structural order, projected
   export binding ID, and immutable module-export denominator. Description may
   select an exact allocator that has no committed Program-ABI locator yet; it
   must not create a draft, locator, alias, registry flag, or prepared-scope
   row. Forged, foreign-session, stale, reused, or mutable descriptors reject.
2. Carry that descriptor in the one-shot
   `PreparedProgramAbiComponentBatchInput`. Preflight import, provider, and
   class-layout provisional bindings first, then resolve every export target by
   exact allocator-object identity against the combined overlay. The resulting
   target must be a required callable/global draft of the expected intent and a
   dependency owned or legitimately borrowed by this exact component. Build the
   canonical `module-value-export` alias draft and add it to the same temporary
   session write set, closure audit, sealed-scope binding set, and final ABI.
   No export draft is visible before the batch's infallible commit section.
3. Reject before any write when the target is missing/foreign, is absent from
   the exact combined overlay, has the wrong intent or slot policy, is unrelated
   to the component, or when external name, export
   object, kind/index, ordinal, entry source, projected ID/order, or module
   denominator drift. Duplicate external names, descriptor entries, IDs,
   structural orders, and double-stage/reuse all fail closed. Multiple distinct
   public exports of one exact target remain distinct ordinal-owned aliases, not
   a deduplication by target.
4. Replace the mutating post-overlay prepared alias call with descriptor
   collection before `scope.stagePreparedComponentBatch`. Keep
   `planAliasesForTargets` only as a compatibility path for already committed
   targets outside this provisional transaction. Final `planRetained()` must
   prove any preplanned alias byte-equivalent and plan only genuinely unrelated
   retained exports; it may never use a late finalization call to repair an
   alias omitted from a sealed provider scope.
5. Abort consumes the descriptor and publishes neither provider nor export
   alias. A healthy component commits both atomically. When a failed and a
   healthy component request the same exported provider, the failed component
   cannot retract or duplicate the healthy component's single provider plan or
   its exact export alias. Registry/session snapshots before description,
   staging failure, injected abort, and stale-currentness failure must remain
   byte- and identity-equal.

Extend the focused transaction suite with positive and one-fact mutation
controls for every row above. The #4588 timer-shim suite must prove the exported
numeric helper seals with its exact alias, executes unchanged in standalone,
and reaches final `planRetained()` without a late sealed-scope mutation. Inject
the pre-seal abort over the same target and prove both provider and alias are
absent while direct fallback remains available. Preserve all B0 diagnostic
visibility assertions independently of export planning.

1. **Scope-owned provisional state.** Add a side-effect-free prepared
   class-layout descriptor over the exact inventory class, final observation, type
   cell/current live struct object, canonical layout string, structural key,
   draft/ref, and existing type-cell locator. It creates no new observation or
   type cell. At descriptor creation and again at seal, require the same
   inventory row, final observation identity/display name, pre-existing cell
   and `cell.current`, and exact struct object still present in `ctx.mod.types`;
   `isEarlyPreparableClassLayout`, canonical layout, and the type registry's
   pre-retained planning state must remain current. The touched session draft/
   reference/locator slots remain absent or byte-identical committed reuse.
   Then extend `PreparedProgramAbiScopeTransaction` with one combined
   one-shot `stagePreparedComponentBatch` operation carrying the exact import,
   provider, class-layout, and prepared export-alias descriptors together with
   the transaction's scope ID, terminal denominator, and requested structural
   keys. Do not expose
   sequential public staging calls that can leave a cross-component or half
   batch. Registry-owned `WeakMap` payloads and a separate nominal lifecycle
   (`fresh -> claimed(exact scope) -> consumed`) authenticate every descriptor;
   a TypeScript brand alone is insufficient. Foreign/forged/double-staged and
   reuse-after-abort/failure descriptors reject, and every seal/abort path
   consumes them. The transaction owns the batch and exposes a readonly ABI
   lookup with the same `get` and
   `bindingIdsForStructuralReference` semantics used by
   `derivePreparedComponentDependencies`. The lookup overlays provisional
   drafts on committed session drafts without inserting them into the session.
   Duplicate provisional IDs/keys, disagreement with a committed row, a
   provider over an unowned import without its exact import descriptor, a
   foreign class layout unless overlaid rederivation produces the exact
   `PreparedProgramAbiBorrowedBindingEvidence`, mismatched scope/terminal/
   request keys, a foreign registry/session, a second/partial batch, or staging
   after seal/abort fails closed.

   At this checkpoint, expose only the minimum descriptor type surface needed
   by the production scope transaction. The new exports must each have a real
   production consumer; do not increase the dead-export baseline.

2. **Pure preflight, infallible commit section.** `seal()` must validate, in
   order, descriptor currentness, combined draft/key/locator/contract
   uniqueness, dependency request ownership, prepared-scope closure, required
   locators, canonical aliases, signatures, and final scope ABI. Build the
   complete scope record and all registry/session write sets in temporary
   readonly collections. Only after every check succeeds may a short commit
   section publish:

   - Program-ABI drafts, structural-order ownership, structural references,
     locator ownership, and callable contracts, including the class draft/ref/
     type-cell locator;
   - the import denominator and `plannedByImport` rows;
   - the provider denominator/append state and `plannedByKey` rows;
   - the prepared export-alias drafts and the prepared-scope record with its
     unit/class/binding reverse indexes.

   Session sidecars publish before registry mappings; the prepared-scope record
   and reverse indexes are the final visibility boundary. After the first
   write, no explicit construction, validator, callback, user code, or fallible
   lookup may run; every row and collection is already built. An unexpected
   exception after commit begins is a fatal compiler invariant and must never
   be converted into per-component Unsupported. Every operation in the commit
   section must be a prevalidated assignment or `Map.set` that cannot invoke
   another validator. If validation throws, ABI publication state does not
   change; consuming every batch descriptor and closing the exact scope ID are
   the only permitted registry/session lifecycle changes. Do not implement
   best-effort rollback after partial mutation.

3. **Abort means observational absence.** `abort()` discards the staged
   descriptors and closes the scope ID. Afterwards the session must return no
   draft, structural-reference reverse row, locator owner, contract, prepared
   scope, or unit/class/binding reverse owner for the aborted batch. Preserve
   the import registry's exact pretransaction sealed/unsealed state; an
   initially unsealed registry remains unsealed. Description never owns observations: the
   provider registry retains every legitimate observation made before or
   during compilation, but gains no frozen order, appended-order entry, or
   planned mapping from the aborted batch. Class observations and pre-existing
   type cells are likewise discovery state and remain, but the aborted class
   gains no draft/reference/locator/scope row. Already committed imports/
   providers/class layouts shared with a healthy component remain reusable and
   are never retracted.

4. **Per-component deterministic fixed point.** Replace the union-wide
   `planBlockingCallableImports`/`planBlockingCallableProviders` publication
   loop with canonical component-by-component staging. Preserve the dependency
   report's canonical component-ID order. For one component whose complete
   blocker set is stageable callable imports/providers and/or class layouts:

   - begin its scope;
   - describe the exact direct imports, provider-backed imports, same-locator
     provider closure, and every preparable class layout;
   - construct one batch whose internal order is canonical imports, provider
     owners/aliases, then class layouts;
   - rederive that component through the scope overlay;
   - require exactly one overlaid component with the identical component ID and
   terminal denominator, and require its resolved external dependency IDs to
     equal the staged request projection plus only the exact canonical locator
     owner/alias closure across every admitted committed import, source,
     support, or provider owner, plus the provisional import owner;
   - include the exact now-resolved provisional dependency IDs; and
   - seal only when its rederived status is complete.

   After a successful commit, remove that component's exact terminal IDs from
   `candidateTerminalUnitIds`, then rederive the remaining candidates against
   the committed session so they reuse the same provider/import/class
   identities. After abort or a non-stageable failure, publish typed Unsupported
   for only that component, remove only its terminal owners, and rederive the
   remainder.
   Reversed request order and fail-first/healthy-first execution must produce
   the same canonical IDs and one provider owner. A mixed callable-plus-layout
   component must be entirely inside this batch; publishing its layout in the
   old global fixed point is forbidden.

5. **Exact test-only failure selector.** Replace the global string equality
   check with grammar `1 | component:<exact-id> | terminal:<exact-IrUnitId>`.
   Parse syntax before publication; after dependency derivation and before any
   descriptor staging/publication, require `1` to match at least one component
   and either targeted form to match exactly one. Invalid, unmatched, or
   multiply matched selectors are invariants, never silent no-ops. Preserve
   `"1"` only as the legacy all-components spelling while existing tests
   migrate; component existence cannot be checked earlier because those IDs
   are derived late. The #4260 two-component fixture must identify the one
   component to abort; it may not depend on report array position or names.

6. **Focused transactional mutations.** The new test must prove all of the
   following against an un-injected control:

   - abort leaves the pre-transaction snapshot delta empty across every
     session/registry reverse lookup and locator owner, even when a healthy
     scope already committed shared rows;
   - adding a lexically earlier provider after abort matches an unpreviewed
     provider-order control;
   - removing the aborted component's import before retained planning matches
     an unpreviewed dense-import control;
   - stale import/provider population, locator, signature, alias, or structural
     key at seal publishes nothing;
   - forged/foreign/double-staged and reuse-after-abort/failure descriptors
     reject without a write;
   - stale class observation/cell/layout, a missing half-batch member, or a
     mismatched scope/terminal/request denominator publishes nothing;
   - removing the class struct from `ctx.mod.types` or crossing retained type
     planning after description rejects without a write;
   - a seal-validation failure after the complete batch is staged publishes
     nothing;
   - two components sharing a provider work in fail-first and healthy-first
     order with exactly one committed provider and one canonical import alias;
   - reversing source/request/component order preserves the committed IDs;
   - a defined provider has one exact allocator owner and no alias/import
     duplication; and
   - a failed component is Unsupported without `preparedComponentId`, while
     the healthy component remains emitted with its exact sealed component ID.

   Mutation assertions must inspect registry/session state directly as well as
   public outcomes. An empty detector, a retained dead provider, or successful
   execution alone is not acceptance evidence.

7. **GC and standalone acceptance.** Use a dedicated `let`/TDZ fixture whose
   prepared body is the only requester of `__new_ReferenceError`, plus the
   shared-provider two-component control. Under the exact injected failure,
   both lanes must compile and execute through direct fallback with
   `legacyBodyEmitted: true`, `irBodyEmitted: false`, no
   `preparedComponentId`, and zero post-claim errors. Compare exact import and
   provider inventories to direct controls:

   - host/GC retains no unused `__new_ReferenceError` import; and
   - standalone retains zero host imports and exactly one live, called
     in-module `__new_ReferenceError` constructor only when the final direct or
     healthy prepared artifact actually needs it.

   The healthy shared-provider control remains sealed/emitted and the final
   Program ABI contains one canonical provider entry. Keep #4259's existing
   `var` regression unchanged; the new `let` evidence belongs here.

8. **Explicit non-solutions.** Do not add `unplanPrepared`, catch-and-delete
   mutations, a DCE exemption, a retained dead import, a
   `__new_ReferenceError` special case, a suffix/name lookup, or a relaxed
   registry invariant. Do not let a failed component appear sealed because a
   healthy sibling committed the same provider. Do not broaden this issue into
   allocator cleanup or general Program-ABI publication rollback.

### Checkpoint, validation, and landing discipline

The issue-plan amendment, descriptor checkpoint, and atomic behavioral fix are
three separate ready PRs. Enqueue each only after its own independent read-only
review; do not stack an unpublished checkpoint behind a queued branch. The
descriptor PR must merge before the behavioral branch is refreshed from live
`main`.

For each implementation checkpoint, run the focused Vitest files, TypeScript 7
and 5, Prettier, IR layering/dialect/fallback, oracle/coercion/optimization,
dead-export, LOC, and function-growth ratchets. Add only measured issue-scoped
budget rows when a ratchet proves one necessary; never raise a global baseline
speculatively. Immediately before every normal signed commit, rerun
`pnpm run check:loc-budget`. Run every normal pre-commit hook, and before every
push run every normal pre-push hook; never use a skip flag or `--no-verify`.
Every heavy command and every commit/push boundary requires a fresh finite,
nonnegative one-minute load strictly below `logical cores - 2`.

## 2026-08-26 implementation handover

Draft PR #4996 carries the atomic-publication checkpoint on branch
`codex/4260-b-atomic-publication`, exact implementation head before this
handover-only update
`493ad47d316d69b16c0db802bb7bbe8eba6d269e`. It stages callable imports,
providers, class layouts, export aliases, and Program-ABI session writes in one
authenticated prepared-component overlay, validates the complete batch before
publication, and retains terminal diagnostic evidence across component-local
aborts. Its focused transaction suite passed 19/19, and its signed checkpoint
passed the normal LOC/function ratchets plus unskipped precommit and prepush
hooks.

This is not final #4260 acceptance. Keep the PR draft until prerequisite #4755
lands and the literal B.7 matrix below passes on current main. The branch is
behind the live integration seams; after #4755 merges, merge live `main` into
this branch without rebasing and semantically review the overlapping
`integration-report.ts` and `integration.ts` changes.

The missing proof must use a prepared component that is the sole
`__new_ReferenceError` requester and cover injected pre-seal failure,
uninjected Prepared, and direct controls in GC and standalone. Require exact
Unsupported/direct-only evidence (`legacyBodyEmitted: true`,
`irBodyEmitted: false`, no `preparedComponentId`, zero post-claim errors), no
stale host import or orphan standalone constructor, and a healthy
shared-provider component that remains sealed/emitted with one canonical
provider. Change production only if that matrix exposes a current-main defect.

The detached `/private/tmp/js2-4260-baseline-debug` worktree contains deliberate
diagnostic edits and is not an implementation source. The cross-lane stop
point and resume order are also recorded in
`plan/agent-context/ir-migration-handover-2026-08-26.md` on draft PR #5000.

## 2026-08-27 dispatch update — B.7 atomic fallback proof

Keep this tracker in progress until the #4755 direct-TDZ prerequisite is
verified on live `upstream/main`. Then dispatch the B.7 behavioral checkpoint
against the descriptor contract above; do not reopen the descriptor design or
add an issue-specific provider cleanup path.

The implementation task is narrowly defined:

1. Use one sole `__new_ReferenceError` requester in a prepared class-setter
   component. Inject the failure immediately before component seal and prove
   typed Unsupported plus exactly one direct emission in both GC and
   standalone. The uninjected/direct controls must retain their established
   outcomes.
2. Compare the aborted artifacts with their direct controls: no unused host
   error import, no orphan standalone constructor, no stale provider/import
   registry row, and no post-claim error. Keep the healthy two-component
   shared-provider control sealed with one canonical provider.
3. Re-run the provider/import planning, scoped dependency, transaction, direct
   fallback, TypeScript 7/5, layering, fallback/oracle/coercion/optimization,
   dead-export, LOC, function-growth, and ordinary hook gates. Reject empty
   receipts and value-only success; the counters and public outcomes are part
   of the proof.

The worker must not touch #3521's linked-Parser selector, #1719's CPR route,
global baselines, or the shared issue-plan files outside this tracker. Land
the behavioral checkpoint only after its descriptor predecessor is on live
main and the exact injection matrix is green.

## 2026-08-27 implementation update — class-setter fallback boundary

The literal B.7 matrix now passes 21/21 in GC and standalone on live `main`
after #4755 and the atomic-publication checkpoint. The matrix covers the
uninjected Prepared artifact, the injected pre-seal Unsupported/direct-only
fallback, an explicit direct control, and the healthy shared-provider control.
It compares terminal outcomes plus exact import, provider, and physical call
inventories; the injected artifacts have no post-claim errors, stale registry
rows, unused host import, or orphan standalone constructor.

The proof exposed one current-main IR ownership defect outside the transaction
machinery: a prepared class setter whose parameter has the canonical `dynamic`
carrier demoted after lowering a concrete RHS because the setter boundary did
not perform the same concrete-to-dynamic boxing already used at direct-call
boundaries. `lowerPropertyAssignment` now uses that canonical boxing helper
before assignability validation and still demotes when no supported carrier can
be produced. No provider cleanup, special-case ReferenceError handling,
registry relaxation, or baseline increase was added.

Standalone direct lowering physically contains both the setter and trigger
ReferenceError call chains, while the prepared component remains the sole
semantic provider requester. The assertions therefore keep exact physical
chain evidence separate from the one canonical Program-ABI provider row. The
focused #4259 accessor suite remains 17/21 on both the checkpoint and an
unmodified live-main control; those four inherited failures are not acceptance
regressions for this checkpoint.

## 2026-08-27 closure reconciliation — atomic publication accepted

PR #4996 (`91e77f7303974ec62a7fd122bbe3187b0f0652df`) landed the
authenticated one-shot prepared-component batch: callable imports, providers,
class layouts, export aliases, and Program-ABI session rows now publish only
after complete validation. Abort consumes the provisional descriptors without
leaving registry, locator, reverse-index, import, provider, or prepared-scope
state behind.

PR #5031 (`14e8e17b6789ee65ca345849df42e33e635ea2b9`) then landed the
literal B.7 acceptance matrix on the post-#4755 baseline. Its 21/21 focused
cases prove injected pre-seal Unsupported/direct-only fallback and the
uninjected Prepared/direct controls in both GC and standalone, with exact
terminal outcomes, zero post-claim errors, no stale host import or orphan
standalone constructor, and one canonical provider retained by the healthy
shared-provider component. Provider/import planning, scoped dependency,
transaction, direct-fallback, TypeScript 7/5, layering, fallback, oracle,
coercion, optimization, dead-export, LOC, function-growth, and ordinary hook
gates passed without a baseline increase or skipped hook.

The four #4259 accessor failures recorded above remain byte-for-byte inherited
on the unmodified live-main control and are outside this issue's atomic
publication acceptance. They do not keep #4260 open. This closure satisfies
only the #4260 dependency; it does not complete parent #3521 or authorize a
later R-stage retirement.
