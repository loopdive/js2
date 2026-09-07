---
id: 3527
title: "IR-only R7: AST-free async suspension plans and canonical Promise ABI"
status: blocked
created: 2026-07-21
updated: 2026-09-06
priority: critical
feasibility: hard
reasoning_effort: max
task_type: refactor
area: ir, codegen, async, runtime
language_feature: async-functions, async-generators, for-await
goal: ir-full-coverage
sprint: Backlog
parent: 3518
depends_on: [3522, 3525, 3526]
required_by: [3528]
horizon: xl
complexity: XL
es_edition: multi
lane: ir-retirement-r7
model: gpt-5.6-sol
related: [351, 1042, 1169f, 1326, 1373b, 2865, 2867, 2895, 2906, 2967, 3090, 3387, 3389, 3518, 4573, 4574]
origin: "#3518 R7 — make the existing frame engine consume AST-free prepared suspension plans"
files:
  - src/ir/async-plan.ts
  - src/ir/nodes.ts
  - src/ir/builder.ts
  - src/ir/verify.ts
  - src/ir/effects.ts
  - src/ir/from-ast.ts
  - src/ir/program.ts
  - src/codegen/async-cps.ts
  - src/codegen/async-frame.ts
  - src/codegen/async-activation.ts
  - src/codegen/async-scheduler.ts
  - src/codegen/function-body.ts
  - src/codegen/closures.ts
  - src/codegen/class-bodies.ts
  - src/codegen/literals.ts
  - src/codegen/statements/nested-declarations.ts
  - src/codegen/declarations/import-collector.ts
  - src/codegen/expressions.ts
  - tests/issue-3527-ir-async-plan.test.ts
loc-budget-allow:
  - src/ir/from-ast.ts
  - src/codegen/ir-prepared-free-functions.ts
func-budget-allow:
  - src/ir/from-ast.ts::lowerExpr
oracle-ratchet-allow:
  - src/codegen/async-linear-planning.ts
  - src/codegen/async-ir-planning.ts
---
# #3527 — IR-only R7: AST-free async suspension plans and canonical Promise ABI

## Execution amendment — 2026-09-05

Complete the active carrier/currentness repair before starting new work. Then
join R6 in package B of the approved
[whole-program cutover plan](3518-ir-only-default-and-direct-frontend-retirement.md#current-execution-plan--whole-program-cutover-2026-09-05).
The prepared program owns the complete async call graph, canonical Promise
contracts, immutable suspension plans, and runtime demands. Preserve the proven
post-issuance invariants while replacing dependence on mutable live-context
joins; do not add another parallel ownership cache. Package A integrates the
producer into the shared driver. The first mixed-application checkpoint must
preserve Promise identity and microtask behavior with zero direct bodies.
All async containers and the original R7 retirement criteria remain in scope.

### Package B executable producer checkpoint — 2026-09-06

`prepareWholeProgramAsyncFunctions` in
`src/ir/runtime-program-producers.ts` now consumes A's complete typed population
and invokes the existing `prepareSuspendingIrFunction` for every unprepared async
owner. It returns the complete ordinary/async/derived population and the existing
`ProgramAbiDerivedUnitRecord` provenance. A's shared population validator runs
before and after production, including pre-existing semantic state calls and
derived owners. No selector-owned set, physical signature inference, new ABI
registry, source callback, or additional ownership cache participates.

Reader/mutator reconciliation confirmed that async production is called by the
existing integration helper, while state functions/provenance are appended there;
A owns replacing that wiring. Runtime attachments are produced in
`intrinsic-support.ts`; `createPreparedIrAsyncRuntime` remains the only issuer
of the existing `preparedManifestByPlan` authentication, with rollback on failed
attachment validation. This change does not edit that WeakMap or replace identity
checks with copied JSON. Physical adapter/materializer calls remain below A/C's
acceptance boundary.

The source-to-IR await handoff accepts explicit `operandType` and `resultType`
evidence. Exact f64 operands retain their original value and await edge; the
semantic async producer declares the Promise number bridge from typed crossings.
This path cannot carry the historical settled-owner receipt fields, preventing
unauthenticated receipt metadata from bypassing their separate ownership checks.
Generic number-boundary policy and existing immutable async planning remain
unchanged. The shared frame uses authenticated box/unbox targets and the
manifest-declared caught-exception import after acceptance.

Focused positive controls exercise the generic two-await state producer,
authenticated host/native projections, and actual gc/nativeStrings Wasm. The
numeric result is 29 with native Promise identity and the exact two-tick trace;
frame emission adds no imports and preserves all nine import identities.
Missing state/provenance, source-body omission, conflicting derived identity,
numeric/receipt contradictions, and copied runtime authority have mutation
controls. Eight distinct focused/regression files pass 118/118;
standalone typechecking passed. Fresh-process source-free reattachment passes with frontend loading blocked
after A's signed identity dependency `1b9ced2df05cd5ac0415508ec6f8299d07767369`.
A deliberately blocked frontend import validates the instrument. A fully
declared settled plan also executes without late imports; a smaller valid
semantic plan receives a typed backend capability refusal before allocation
because the shared frame still requires all core host adapters.

The existing producer still declines an async function with zero awaits, such
as a typed `async immediate() { return 3; }`, and existing manifest providers
still lack a linear async backend. These are located failure-evidence rows,
not coverage or preserved behavior claims. The unchanged mixed application,
zero direct body count, real cross-backend replay, and full R7 retirement
remain open.

### Source-free physical async bridge implementation plan — 2026-09-06

Root approved the first slice and the exact second mechanical slice below on
2026-09-06, after reviewing this plan, the fresh ownership census, and the
preserved local worktree hunks. B must adopt A's signed direct-import dependency
before removing the barrel. A also has the narrowly granted physical import/tag
extraction recorded below. Other engine/materializer extractions still await
exact source-ownership review.
The source review is grounded in signed producer commit
`4d4c22ef222b8b55ab3e44901458940109f2525c`, also inspected in the integration
worktree. It concerns the runtime import closure of `ir-async-frame.ts` and
`ir-async-runtime-adapters.ts`; C retains exclusive ownership of the codec,
prepared-program consumer, backend emitters, and replay. No import substitution
below, by itself, establishes source-free async emission.

#### Observed dependencies and mutation boundaries

These are runtime imports, not TypeScript-only annotations. Paths in the first
two columns are relative to `src/codegen/` unless prefixed with `src/`.

| Bridge dependency | Short route to frontend loading | Required boundary |
| --- | --- | --- |
| `ir-async-frame` → `async-frame` | `async-frame` → `src/ts-api` → `typescript`; also `async-cps`, `index`, and `checker/type-mapper` | Extract the actual prepared frame engine from AST planning and dispatch. |
| `ir-async-frame` → `shared.coerceType` | `shared` → `src/ts-api`; registered implementation in `type-coercion` → `index` | Extract the required typed coercion implementation, not the delegate or its registrar. |
| `ir-async-frame` → `func-space.definedFuncAt` | `func-space` export-star → `multi-source-ir-integration` → `src/ts-api` | Remove the unrelated frontend barrel; keep stable-handle accessors unchanged. |
| adapters → `registry/imports.addImport` | `registry/imports` → `src/ts-api`, `declarations`, `checker/type-mapper`, `index` | Separate physical import/tag registration from AST collection and late fixups. |
| adapters → `registry/types.addFuncType` | `registry/types` → `closures/funcref-wrapper-types` → `index` | Import the existing header leaf, then make the wrapper registry use the type registry directly. |
| adapters → `async-scheduler.ensureAsyncDriveRuntime` | `async-scheduler` → `closures` → `src/ts-api` | Remove the barrel dependency; scheduler materializer dependencies still need extraction. |
| adapters → `any-helpers.canonicalUndefinedExternInstrs` | `any-helpers` → `native-strings` → `native-strings-selfhost` → `stdlib-selfhost` → `src/ir/from-ast` | Extract the existing AnyValue/undefined carrier materializer from broad string/object helpers. |
| adapters → `native-promise-number-boundary` | number boundary → `shared.addUnionImportsViaRegistry`; implementation registered by `index` | Materialize the exact accepted number providers directly before sealing. |
| frame → `compiler-support-abi.recordAsyncFrameMachinery` | support ABI → `program-abi-planning` → `src/ir/identity` → `src/ts-api` | Use A's existing pure identity factory; preserve the session and owner contracts. |

The scheduler also directly imports `registry/imports`, `shared`,
`native-strings`, `registry/error-types`, `closed-method-dispatch`, and
`object-runtime`. In particular, its actual thenable/callback substrate calls
`reserveClosedMethodDispatchVararg`, `ensureObjVecBuilders`, and
`reserveApplyClosure`; `object-runtime` imports `stdlib-selfhost`, while
`closed-method-dispatch` imports source statement/declaration machinery. These
are part of the remaining physical bridge dependency chain. Redirecting the
closure imports does not remove them. `unhandled-rejection` cycles back to the
scheduler. The reviewed `prepared-native-async-await`, `frame-core`,
`context/locals`, `closures/closure-header-layout`, and
`arguments-carrier-brand` leaves already have no frontend value import.

Reader/mutator inventory before any extraction:

- The three exported multi-source helpers have runtime readers only in
  `src/ir/integration.ts`: `collectIntegrationFunctionDeclarations`,
  `makeMultiSourceOverrideResolvers`, and `resolveIntegrationSourceFiles`.
  The existing `func-space` accessors remain the single handle lookup/mint/push
  authority; changing the export edge does not move their state.
- `addImport` mutates module imports, function/global import counts and lookup
  maps, and preserves strict-host/frozen-index-space checks. `ensureExnTag`
  owns the local or shared imported exception tag through those same registries.
  All callers must continue to reach the same implementation, never a copied
  registry or a new lazy import fallback.
- `registry/types` owns existing physical type caches. Wrapper type factories
  and `closureBagField` must retain their current layouts and cache identity.
  `program-abi-planning` and `program-abi-import-planning` consume
  `createIrBindingId`; `src/ir/identity-values.ts` is the already committed
  canonical source-free implementation.
- `emitPreparedAsyncFrameStateMachine` calls `emitAsyncFrameEntry`, which calls
  `ensureAsyncResumeFunction`; the latter owns resume/step function allocation,
  emitted bodies, handlers, and frame bookkeeping. `buildStepAdapterLocals` and
  `buildStepAdapterBody` are shared engine mechanics. `planAsyncResumeCfg`,
  declaration-based type resolution, `compileExpression`, and
  `compileStatement` are source producers and must stay above that engine.
- Undefined/type globals are owned by `ensureAnyValueType`; reads go through
  `undefinedExternInstrs`/`canonicalUndefinedExternInstrs`. Scheduler state is
  owned by `getOrRegisterPromiseType`, `ensureMicrotaskQueue`,
  `ensurePromiseSettleFunctions`, and the helper factories reached from
  `ensureAsyncDriveRuntime`. Number-boundary publication marks existing helper
  exports and asks the existing `ProgramAbiSession` export planner for aliases.
- `shared.coerceType`, `addUnionImportsViaRegistry`, `addStringImportsDelegate`,
  `ensureLateImport`, and `flushLateImportShifts` are registered delegates.
  Registrars reside in `type-coercion.ts`, `index.ts`, and `expressions.ts`.
  Importing those source modules for side effects is not a replay solution.

#### Smallest executable first slice

1. B is authorized only to remove
   `export * from "./multi-source-ir-integration.js"` in
   `src/codegen/func-space.ts` and a focused
   `tests/issue-3518-runtime-producers-import-boundaries.test.ts` control,
   and update this issue. Preserve every registry/handle implementation.
2. A has explicitly reserved the matching `src/ir/integration.ts` import hunk:
   import the three source helpers directly from `multi-source-ir-integration`.
   Existing physical `func-space` imports remain there. B does not edit
   `integration.ts`; A acknowledged this coordination on 2026-09-06.
3. A fresh process must import `func-space` with frontend loading blocked, and
   a deliberate `ts-api` import must fail to prove the barrier is active.
   Run the existing `issue-1916-symbolic-func-refs` and
   `issue-3520-integration-pass-identity`/`integration-population-identity`
   tests plus typechecking. Report actual test denominators. This slice proves
   the handle leaf is independent; the two async bridge roots remain impure.

The first slice is signed as `131f2327544d6a5d57a90d38358c31d644be292c`,
on verified signed A dependency `1dea8e0cf4db8dae3f834e733e111397ce58bf18`. Its fresh-process test observes the
real handle/layout module loads, preserves exact stable-handle lookup identity,
and separately rejects deliberate `ts-api` and multi-source frontend imports.
The four named focused files pass 26/26; standalone typechecking passes. Only
the unrelated export edge was removed from the handle registry. This is a
physical leaf import-boundary result, not whole-frame or replay completion.

#### Remaining mechanical cuts

Root's second grant permits only these six value-import substitutions across
five files, plus now-stale import-area comments. Apply after A's signed
direct-import dependency and the first `func-space` slice. Keep the paired
registry/header and wrapper/type-registry substitutions together; preserve
every definition, compatibility re-export, registry, session, and seal.

- `registry/types.ts`: import `closureBagField` from
  `closures/closure-header-layout.ts`.
- `closures/funcref-wrapper-types.ts`: import `addFuncType` from
  `registry/types.ts`, preserving all wrapper factories and reexports.
- `async-scheduler.ts`: import `getClosureFuncSelfTypeIdx`,
  `getOrCreateFuncRefWrapperTypes` from the dedicated wrapper registry; import
  `closureBagField` and `closureBagInitInstr` from the header leaf. The exact
  root-wrapper lookup, `getFuncRefWrapperRootTypeIdx`, is already imported
  directly from `closures/funcref-wrapper-types.ts`; leave that import and its
  three call sites unchanged.
- `program-abi-planning.ts` and `program-abi-import-planning.ts`: import the
  runtime `createIrBindingId` factory from `src/ir/identity-values.ts`; keep
  identity types and all session/planning behavior unchanged.

The one-shot local owner review inspected 94 existing paths from 114 linked
worktree records. Three older worktrees have `program-abi-planning.ts` edits:
R4 call-free recovery changes adjacent imports/role-table and module-alias code;
the two PR4823 shepherd worktrees add C35 role ordinals. All leave the proposed
`createIrBindingId` import unchanged. Preserve these edits and every held claim.
One worktree is locked initializing; twenty linked paths are absent. Neither
condition implies abandoned work or permission to delete anything.

The exact C31/session claim branches have local and origin refs but no matching
linked worktree. Local merge records identify PR3827 (C31), PR3825 (session
seal), and PR3831 (scoped seal). Their merge commits are not reachable from
integration `8461d61680c142da712c84bf2ba566767aee3920` in the available shallow
graph, so integration ancestry remains unknown; this does not mean unmerged.
The scoped claim has no recorded branch, although the corresponding named
local/origin branch refs and merge record exist. Root grants only the specified
import/comment hunks; no ownership or claim release is inferred.

The six granted imports are now substituted on the signed first slice. The
focused fresh-process control additionally loads the type registry, wrapper
registry, closure header, and both ABI-planning leaves with the frontend blocked;
it exercises fresh wrapper creation through the changed `addFuncType` import,
exact cached `ClosureInfo` reuse, the existing host-one-shot to ordinary
allocation-mode transition, and shared header factories. Root and A requested
this factory control before the affected cohort because a seeded-root getter
alone would not execute the changed import. The existing async frame and scheduler roots still require their planned physical
extractions. The nine-file affected cohort passes 118/118, including all three
fresh-process boundary controls and all 25 runtime-producer controls. The first
attempt exhausted the default 512 MB worker heap before reporting any tests;
its log is retained separately. The complete repeat used the repository's
existing `VITEST_FORK_MAX_OLD_SPACE_SIZE=4096` setting and one fork, with the same
nine files and assertions. Full typechecking passes.

Validate the resulting leaf imports and the existing compiler-support ABI,
callable-planning, import-callable-planning, and closure-host-bridge ABI tests.
Preserve all `ProgramAbiSession`, scoped-seal, owner/currentness, and constructor
controls. These cuts cannot complete either physical async root on their own.

#### Actual engine and materializer extraction

Root granted A only the `addImport`/`ensureExnTag` portion of step 1 on
2026-09-06, after its current preparation signature. A owns the new
`src/codegen/registry/physical-imports.ts`, those two bodies and their
import/re-export hunk in `registry/imports.ts`, and a dedicated A test. The
functions need only the existing import allowlist helpers and `addFuncType`;
source-free verification depends on B's paired registry/wrapper import cuts.
A does not edit B's adapters, frame/scheduler work, or later numeric-carrier
scope. B/C adopt the physical leaf through their own consumers after A's signed
handoff. Preserve the PR5400/5063 fixup/iterator bodies and all claims. B will not
edit A's registry hunk concurrently.

All other physical steps below still require exact source-ownership review.
They move existing implementations and their precise typed dependencies; they
do not add a second CPS engine, ownership cache, or backend implementation.

1. **Physical registries and value carriers.** Extract `addImport` and
   `ensureExnTag` from `registry/imports.ts` into a pure physical registry leaf,
   reexporting the same functions for source callers. Retain tag identity,
   strict-host diagnostics, counts, and freeze discipline. Extract
   `ensureAnyValueType` and the canonical undefined read/build helpers from
   `any-helpers.ts` without pulling in native string selfhosting. Reserve every
   required type/global/import before frame emission, including the shared-tag
   case which the previous nine-import test did not cover.
2. **Number and typed coercion materializers.** Extract the exact required
   numeric bridge implementations reached through `registry/imports.ts`
   (`addUnionImports`/`addUnionImportsAsNativeFuncs`) and `any-helpers.ts` into
   directly callable accepted-provider materializers. Preserve the existing
   `__typeof_number`/`__unbox_number` signatures and alias publication in
   `native-promise-number-boundary.ts`. Extract the prepared carrier operations
   used by `ir-async-frame.ts` from `type-coercion.ts`; the new engine cannot
   depend on `shared` delegates, source bootstrap, or undeclared generic boxing.
3. **Prepared frame mechanics.** Move the actual shared resume/step/entry
   implementation from `async-frame.ts` to a dedicated physical engine leaf.
   Split the common mechanics from the source planner at their input boundary;
   existing source compilation and prepared IR must both use that one engine.
   Keep AST statement/expression/type resolution in the source adapter. The
   `async-cps.ts` prepared operand/CFG type guard (`isEmitOperand`) needs a pure
   boundary or a directly typed replacement; merely wrapping its AST-dispatch
   union is insufficient. Physical emission callbacks may exist below
   acceptance, but never in `PreparedIrProgram` or serialized semantic data.
   B owns only this async physical bridge; C supplies backend consumption.
4. **Native scheduler closure.** Extract the existing typed Promise, queue,
   settlement, reaction, and drive helper materializers from
   `async-scheduler.ts`, retaining thenable assimilation and rejection tracking.
   Resolve its real callback/thenable dependencies in `closed-method-dispatch`,
   `object-runtime`, `registry/error-types`, and native-string helpers through
   their actual typed runtime materializers. Source-authored helper bodies must
   already be semantic prepared units; replay may not invoke `stdlib-selfhost`
   or `from-ast` to regenerate them. Request each concrete subordinate
   extraction before touching those owners. This is remaining implementation
   work, not an assumption that the current broad helper modules are pure.
5. **Authenticated bridge handoff.** Reconcile the complete extracted import
   closure of `ir-async-frame.ts` and `ir-async-runtime-adapters.ts`, then run a
   fresh-process import and actual frame/materializer execution with
   `typescript`, `ts-api`, `from-ast`, async source planners, `codegen/index`, and
   `compiler` blocked. Keep the existing plan/manifest/adapter authentication.
   Regenerated runtime evidence is compared to decoded evidence before
   reattachment; copied objects do not acquire authority by shape alone.

Focused regressions must retain the B producer suite's numeric result 29,
native Promise identity, exact two-tick trace, nine stable import identities,
fully declared settle-only execution, and typed minimal-plan refusal before
allocation. Also run `issue-4103-ir-async-runtime-providers`,
`issue-4104-ir-async-plan-runtime-consumer`,
`issue-3527-linear-suspension-preparation`,
`issue-3527-linear-suspension-runtime`, `issue-3527-settled-owner-runtime`,
`issue-3527-async-call-closure`, `async-frame-host-throw-rejects`,
`issue-4167-async-rejection-identity`, `issue-3587-async-rejection-delivery`,
`issue-2906-async-multiawait`, `issue-2895-async-frame`,
`issue-2895-drain-hook`, and `issue-4574-standalone-native-async-family` as their
respective engine/materializer paths change. Add a nonempty module-load trace,
a deliberately rejected frontend import, and shared-exception-tag stability
controls. Gate every heavy job on finite numeric `load1 < cores - 2`; retain
normal hooks and report actual counts rather than proposed denominators.

Fresh zero-await owner support, the shared frame's all-core host adapter
requirement, and missing linear async providers remain explicit gaps. C/root
own actual unchanged mixed-application emission and replay through both
backends. Its source digest remains
`236fa7d971bf9b86aafa778a9a441b2440bae2e2c2c0ae7fdab3f6e517c517fb`.
Neither import tests nor the completed seven-original-unit preparation are
evidence of seven emitted-once bodies, zero direct bodies, or cross-backend
runtime success.

#### Read-only ownership and PR census

The remote assignment read succeeded (`ref_read: ok`) at
`issue-assignments` tip `b125009976288361bf8d7bf7e59daf6b038a090b`, with
2,068 records and 754 held claims, observed 2026-09-05 23:40 UTC
(2026-09-06 local). An initial sandbox DNS failure was retried read-only;
it was not interpreted as an empty ledger. No claims were changed.

- B retains `3518:semantic-runtime-producers` as
  `ttraenkler/astra-ir-producers-b-20260905`. A holds
  `3518:authoritative-preparation`; external Claude Fable holds
  `3518:backend-consumption-replay`; D holds `3518:application-evidence`;
  root holds `3518:integration-consolidation`. Their distinct linked worktrees
  are present. This follow-up does not transfer any of those surfaces.
- Protected held claims include R1's `c31-closure-host-bridge` (and c30/c32/c33,
  `w1g-implicit-ctor-param`), R2's `program-abi-session-seal` and
  `scoped-prepared-abi-seal`, R3's `w1c-super-accessor`, and R4's `r4m1`/`w2b`.
  A missing linked worktree for a historical claim is not permission to edit.
- R7's `r7-b2-linear-suspension-liveness` and
  `r7-b3-settled-nonthenable-owners` remain held by their Luna owners, with both
  linked worktrees present. R6's a1/f3s1/f3s2/f3s3 claims remain held. This plan
  preserves their immutable source planning and canonical provider evidence.
- The fresh open-PR census returned 11 PRs. No listed PR changes `func-space.ts`,
  `registry/types.ts`, or `closures/funcref-wrapper-types.ts`. This is only a
  read-only snapshot; root still grants the exact source slices.
- PR 5632 (`codex/3525-m2-p2a-luna-20260905`, head `5aec08c33b3381ddb55a33a152d05833bb9d7b78`)
  changes `src/ir/integration.ts`; its `3525:m2-p2a-atomic-init-batch` claim and
  linked worktree remain present. A owns reconciliation of its import hunk.
- PR 5400 (head `0023f522023156ea63d973fab1fed932b2ccfa09`) changes
  `registry/imports.ts` in `fixupModuleGlobalIndices` for NewTarget. PR 5063
  (head `d070b5583e66be23903031e4bed0556559026d34`) changes that file in
  `addIteratorImports` for yield-star throw. Read diffs confirm these are
  separate functions from `addImport`/`ensureExnTag`; preserve them and request
  only the two physical registration functions, never broad registry ownership.
  The current 3371 claim is `ttraenkler/fable-es6`; the open PR does not itself
  establish that claimant's identity or release another owner.
- Broad transitive modules also overlap open work: `object-runtime.ts` in
  PR 5397, `generators-native.ts` in PR 5063, and `codegen/index.ts` in
  PRs 5640/5632/5400/5397. The proposed first slice edits none of them. Later
  extraction requests must identify the exact shared functions and refreshed
  owners, without taking C's emitter work or A's compiler wiring.

## Objective

Prepare every supported async function-like as one immutable, AST-free
`IrAsyncPlan` before emission, then lower that exact plan through the existing
frame/resume runtime for JS-host, standalone, and WASI.

The plan owns real suspension states, SSA/ref-cell/slot liveness, resume values,
handler/unwind edges, async-generator operations, and typed runtime intents. It
contains no TypeScript AST/checker objects, legacy `FunctionContext`, Wasm
`ValType`, function/type/import indices, target flags, source binding names, or
codegen callbacks. Declarations, nested declarations, arrows/function
expressions, instance/static/object methods, `for await`, and async generators
all follow the R0 Prepared/Unsupported/Invariant and compile-once contract.

R7 reuses the one production N-state frame engine and its host/native
settlement substrates. It does not create a second CPS engine. R8 later teaches
linear lowering to consume the same `IrAsyncPlan`.

## Current evidence

### One engine, but an AST-bearing plan

- `src/codegen/async-activation.ts:70-129` chooses `drive`, `host-drive`, or
  legacy sync pass-through. `maybeActivateAsync` at `:178-195` rewrites an
  already-registered legacy body; closure planning/emission has a separate ABI
  split at `:206-245` / `:248+`.
- `src/codegen/expressions.ts:1448-1454` confirms the older separate CPS emitter
  is deleted. The frame/resume engine is the one substrate to retain.
- `src/codegen/async-cps.ts:67-108` stores `ts.AwaitExpression`,
  `ts.ForOfStatement`, and AST-keyed liveness/settlement maps.
  `LinearAwaitPlan` at `:488-518` retains statements, expressions, and type
  nodes.
- `src/codegen/async-cps.ts:800-959` puts raw emit callbacks,
  `CodegenContext`, `FunctionContext`, `ValType`, AST operands/statements, and
  AST finalizers into `AsyncCfgPlan`. Producers `planAsyncCfg` (`:1047+`),
  `planWhileLoopCfg` (`:1186+`), `planForAwaitCfg` (`:1521+`),
  `planForAwaitAsyncCfg` (`:1807+`), and `planAsyncGenCfg` (`:2516+`) therefore
  cannot be a backend-neutral IR contract.
- `src/codegen/async-frame.ts:242-455` stores the declaration, source names,
  concrete Wasm types/indices, legacy capture layout, and target-specific host
  state. It rereads AST/checker state to guess spill and derived-parameter
  representation.
- `ensureAsyncResumeFunction` at `src/codegen/async-frame.ts:1020-1058` runs
  the AST planner during backend emission. State emission at `:1402-1874`
  executes callbacks and direct `compileStatement`/`compileExpression`,
  including copied finalizer statements. `emitAsyncFrameStateMachine`
  (`:2004-2045`) still starts from a legacy `FunctionContext`.

### Containers and call ABI remain direct

- `src/codegen/function-body.ts:1195-1219` performs legacy hoisting first, then
  activation; a decline falls into the direct statement loop.
- `src/codegen/closures.ts:1880-1916` fixes the legacy wrapper/capture ABI before
  activation and chooses frame versus direct AST body at `:2454-2469`.
- `src/codegen/class-bodies.ts:2213-2235` gives plain async methods the unwrapped
  direct signature; ordinary methods reach direct statements at `:2489-2505`.
- `src/codegen/literals.ts:2807-2817` and `:2991-3075` repeat the split for
  object methods. `src/codegen/statements/nested-declarations.ts:672-710` and
  `:1098-1172` repeat native-gen/async-gen/eager/direct forks.
- `src/codegen/declarations/import-collector.ts:97-108`, `:805-850`, and
  `:1743-1815` predict async host imports from AST before bodies; methods are
  absent. Its async-generator census at `:1026-1086` also drives module-wide
  representation policy.
- `src/codegen/expressions.ts:165-245`, `:360-445`, and `:1324-1498` detect
  async callees and consumers by checker/name registries, switch between raw T
  and Promise, wrap at call sites, and treat some await forms as identity.

### Current IR does not represent suspension

- `src/ir/nodes.ts:775-829` has await/async return/throw instructions whose
  comments defer true CPS; block terminators at `:2487-2512` contain no
  suspension edge. `IrFunction.funcKind` at `:2537-2588` lacks an
  async-generator plan.
- `src/ir/from-ast.ts:601-633`, `:713-727`, and `:2459-2485` unwrap async
  declarations to raw T and lower await as static substitution, pass-through,
  or a non-suspending instruction.
- `src/ir/lower.ts:2932-3007+` creates settled native Promises for return/throw;
  await is host identity or a native field unwrap, not observable suspension.
- `src/ir/select.ts:434-445` admits only top-level engine-declined declarations.
  Methods, closures, async generators, and `for await` remain rejected at
  `:1061-1079` and `:3060-3068`.
- `src/codegen/async-scheduler.ts:4296-4321` can change the whole standalone
  Promise carrier when one module contains a non-drivable async generator. A
  local Unsupported unit therefore changes unrelated representation.

## Preliminary async-gate reconciliation

`scripts/check-ir-fallbacks.ts:230-268` calls the bare selector without either
`supportsAsyncIr` or the production `asyncEngineClaims` predicate. The selector
therefore reports all four functions in
`website/playground/examples/js/async.ts` as
`deferred.async-function=4`, regardless of their production routes.

Production supplies the missing options during prepared-component discovery,
so the old four-label result was neither one coherent migration population nor
compile-once evidence. #4124 now reconciles the preliminary labels with exact
source-qualified production terminal outcomes: all five playground async free
functions are prepared/compile-once, the gate records
`async-function: 4 -> 0`, and the bounded host ledger records 37/37 IR bodies
with no Unsupported outcome. The production unit ledger remains the authority.

This completes only the free-function terminal family. Async methods,
closures/function expressions/arrows, `for await`, async generators, `yield*`,
standalone/WASI consumers, and deletion of the AST planners/activation census
remain unchecked acceptance work below.

## Standalone continuation (#4573, 2026-08-20)

After #4566, the standalone terminal census was 22 IR bodies and 15
legacy/typed Unsupported bodies. #4573 prepares the exact checker-certified
`new Promise((resolve) => setTimeout(() => resolve(value), ms))` delay owner
through the native `$Promise` substrate and one explicit embedder timer
capability. It removes the executor closure rather than replaying the direct
body, preserves grounded numeric operands and one-shot rejection/settlement,
and authenticates the dedicated timer callback dispatcher without retaining
the generic closure host bridge. The checkpoint is **23 IR / 14 legacy / 14
Unsupported / 0 Invariants**, with `body-shape-rejected` reduced from 3 to 2.

This closes only the standalone delay dependency root. The remaining async
terminals are exactly `fetchUser`, `fetchAllSequential`, `fetchAllParallel`,
and async `main`. The next dependency-complete slice must project their
existing prepared `IrAsyncPlan`s through the native frame/runtime, preserve
numeric Promise carriers and typed spills, eager/order-correct `Promise.all`,
proven vector bounds, fixed vector literals, ambient clock snapshots, fused
five-part concatenation, specialized number formatting, and typed string
logging, and reduce the standalone census from **14 to 10** without reopening
a legacy callee edge. JS-host, WASI, generic Promise constructors, async
methods/generators, and source near misses are not widened by #4573.

## Standalone async-family continuation (#4574, 2026-08-20)

#4574 owns the dependency-complete native projection for `fetchUser`,
`fetchAllSequential`, `fetchAllParallel`, and async `main`. It reuses the
existing immutable host-certified `IrAsyncPlan`s, shared frame engine, native
`$Promise` scheduler, and native Promise combinator; it does not add another
frontend or async engine. The checkpoint is **27 IR / 10 legacy / 10
Unsupported / 0 Invariants**, with all four `select/async-function` outcomes
removed and `delay` remaining compile-once.

The completed slice preserves typed sequential spills and ordering, eager but
input-order-correct Promise.all, the fixed ID vector, four deterministic
standalone clock snapshots, fused five-part string concatenation, specialized
number formatting, typed output, and native undefined settlement. The current
direct standalone family resolves or fans out too early and is not a semantic
runtime oracle; #4574 uses source/spec traces and existing host-plan evidence
for correctness while retaining direct only as an artifact/optimization
reference. Its authoritative result is **27/37 IR, 10 legacy/Unsupported, zero
Invariants**. Focused coverage passes 13/13, related async/provider coverage
39/39, #4124 11/11, and #4573 12/12. The tuned IR artifact is smaller than
direct at **125,889 vs 133,307 raw bytes**, **55,276 vs 57,037 gzip-9 bytes**,
**1,081,058 vs 1,197,082 WAT characters**, and **346 vs 353 functions**; both import exactly one timer
capability. Raw `main` fulfillment proves the canonical native value is
undefined tag 2 rather than null tag 1 before JS boundary normalization.
Calendar six and Builtins four remain separate capability/storage families.

## `IrAsyncPlan` contract

Extend function kind with `async-generator` and attach a verified plan to every
Prepared async unit. Exact type names may follow repository conventions; the
contract is fixed:

- state IDs and IR-only state bodies;
- terminators for `suspend`, `goto`, conditional branch, resolve, reject,
  yield/resume, and completion;
- each suspend edge carries an awaited `IrValueId`, successor-defined resolved
  value, resume state/block, and rejection/unwind target;
- explicit handler/catch/finally regions and completion replay by IDs, never
  copied AST statements;
- cross-suspend live SSA values, locals/slots, receivers, and mutable ref cells
  with `IrType`;
- semantic runtime intents from #3526 for Promise capability/adoption/reaction/
  settle, scheduler/drain, iterator/async-iterator/close, iterator result, and
  async-generator next/return/throw;
- stable source locations only as diagnostics metadata, never as executable
  source objects.

The same serialized plan/hash must be presented to host, standalone, WASI, and
linear. Only lowering selects a host Promise/reaction adapter or native
`$Promise` scheduler. All Prepared async callables expose one canonical Promise
or async-generator carrier ABI in `ProgramAbiMap`; consumers never select raw T
versus thenable ABI. Every await preserves asynchronous ordering, including a
statically settled operand.

`for await` lowers in the front-end to typed iterator intents with async
iterator lookup, sync fallback, `next`, `done`, `value`, and abrupt `return`/
close. Async-generator `yield*` uses the same iterator intents plus suspend/
yield edges. No direct emit hook is permitted.

## Dependency and policy locks

- #3519 owns typed terminal outcomes; a plan/backend mismatch is Invariant,
  never fallback.
- #3520/R1 identity and #3525/R5 whole-program resolution own frame/helper IDs,
  cross-file calls, delegation, and source order. Sanitized-name collision or
  earlier-declaration requirements are not valid IR contracts.
- #3521/R2 and #3522/R3 own preparation, captures, receivers, home object,
  `this`, `super`, `arguments`, and method ABI. R7 never plans from an activating
  legacy `FunctionContext`.
- #3526 owns Promise/scheduler/iterator runtime intents and freezes them before
  resume-body lowering.
- #3528 consumes this exact plan for linear; it may not add another async
  frontend. Top-level await/module async evaluation stays source-located
  Unsupported until an explicit R4 extension defines it.
- Authoritative standalone/WASI evidence is cold-process evidence; warm/batch
  results cannot close R7 because current carrier state has order dependence.

## Bounded A–G landing sequence

### A — define verified async suspension IR

- Add `src/ir/async-plan.ts`; extend nodes, builder, verifier, effects, exports,
  function kind, true suspend/yield/completion edges, liveness, and handlers.
- Test hand-built plans only. No routing change.

### B — prepare free async functions with canonical Promise ABI

- Lower await/return/throw/calls into plans and attach them to
  `PreparedIrProgram` before emission.
- Refactor the WasmGC host/native frame adapter to consume plans without AST or
  legacy contexts. Remove raw-T C1 behavior only for Prepared units.

### C — preserve async closure environments

- Cover arrows, function expressions, nested declarations, captures, mutable
  ref cells, derived/destructured parameters, and lifted async function kind.
- Stop using `planAsyncClosureActivation` for migrated units.

### D — prepare async class and object methods

- After R3, cover instance/static/object receiver, home-object, `super`,
  `arguments`, parameter prologues, and captures. Remove their direct statement
  loop only when compile-once evidence passes.

### E — lower `for await` through iterator intents

- Cover async and sync sources, genuinely pending `next`, done/value,
  destructuring, break/throw, and exactly-once iterator close.
- Delete `emit`/`postDeliverEmit` callbacks for migrated paths.

### F — lower async generators through the same plan

- Cover lazy entry, await/yield, fresh operation Promises, next/return/throw,
  rejection/completion, and `yield*` across host/native carriers.
- Remove the module-wide non-drivable carrier fallback and eager host buffer for
  Prepared units.

### G — remove async AST planners and activation hooks

- Delete `async-activation.ts`; delete AST/callback planning portions of
  `async-cps.ts` and AST/checker planning from `async-frame.ts`.
- Replace async import census with #3526 runtime intents; remove container
  activation/direct routes and Prepared-unit call wrapping/legacy await paths.
- Retain frame-core and scheduler/provider behavior behind semantic plans. The
  R0 ledger must show zero fallback/direct emissions before deletion.

## File ownership and locks

A/B establish the contract and require one owner for `src/ir/async-plan.ts`,
the named IR core files, `src/codegen/async-cps.ts`,
`src/codegen/async-frame.ts`, `src/codegen/async-activation.ts`, and Promise ABI
integration. C–F may be separate sequential sub-slices, but a slice owns its
container file plus frame adapter end-to-end; do not split one activation/body
fork between developers.

Coordinate runtime intent/provider edits with #3526 and linear adapters with
#3528. `src/codegen/async-scheduler.ts` is retained substrate and should change
only where the typed provider adapter requires it.

## Anti-vacuity tests

`tests/issue-3527-ir-async-plan.test.ts` must prove:

1. Plan purity: serialized plan/hash is identical under host, standalone, and
   WASI; dependency/type guards find no AST, codegen context, callback,
   `ValType`, runtime index, or target flag.
2. A manual plan with two suspends, a branch/back-edge, and handler has exact
   SSA/ref-cell/slot liveness and successor result binding; invalid state,
   handler, and liveness edges fail verification.
3. A Prepared async unit records `legacyBodyEmitted:false`, direct=0/IR=1;
   poisoning every legacy async dispatcher leaves execution green.
4. A genuinely pending order trace is
   `[sync-prefix, after-call, resume, finally, settle]`; no suffix runs before
   host settlement or native drain, including `await Promise.resolve(...)`.
5. Two awaits spill scalar/reference/receiver/captured mutable ref-cell and
   derived destructuring values correctly through fulfillment and rejection.
6. Pre-await throw rejects the result Promise; catch/finally and return/throw/
   break completion replay across suspension preserve source order.
7. Top/nested declaration, concise/block arrow, function expression,
   instance/static/object method genuinely suspend and preserve capture,
   `this`, home object, `super`, and `arguments` behavior.
8. `for await` covers zero/multiple elements, pending `next`, async/sync source,
   getter/next counts, pattern heads, and exactly-once close on break/throw.
9. Async generators are lazy; every next/return/throw returns a fresh Promise;
   await/yield/order/done/value/rejection/`yield*` traces match across targets.
10. Same-name async units across files/classes and forward/delegate references
    prove structural identity and source-order independence.
11. A deliberate unsupported form returns a stable code/span and emits no
    body; a missing adapter/runtime intent is fatal Invariant, not Unsupported.
12. The IR-only gate consumes production outcomes and fails if it restores the
    old bare-selector `async-function=4` shortcut or catches a compile error.

Run adjacent suites including `tests/ir/issue-1373b.test.ts`,
`tests/issue-1042-host-drive.test.ts`, `tests/issue-2895-async-frame.test.ts`,
`tests/issue-2967-engine-convergence.test.ts`,
`tests/issue-2906-3b-forawait.test.ts`,
`tests/issue-2906-3dii-asyncgen-consumer.test.ts`,
`tests/issue-3228-forawait-dstr-standalone.test.ts`,
`tests/issue-3387-asyncgen-forawait-dstr.test.ts`, and
`tests/issue-3389-asyncgen-return.test.ts` in isolated host/standalone/WASI
processes where required.

## Acceptance criteria

- [ ] Every supported async container/protocol has one verified AST-free
      `IrAsyncPlan` attached to its Prepared unit before emission.
- [ ] Plans contain real suspension/liveness/handler/runtime-intent semantics
      and no AST/checker/codegen/Wasm-index/callback state.
- [ ] Prepared async callables use one canonical Promise/async-generator ABI;
      consumer-sensitive raw-T wrapping and await identity are absent.
- [ ] The existing frame/resume engine consumes the same plan for host,
      standalone, and WASI with observably asynchronous, equivalent traces.
- [ ] Free functions, closures/nested functions, arrows/expressions,
      class/static/object methods, `for await`, async generators, and `yield*`
      pass compile-once and anti-vacuity coverage.
- [ ] Async-specific AST planners, activation hooks, import census, direct
      container routes, module-wide carrier fallback, and Prepared-unit call
      wrappers are unreachable and removed after zero-direct proof.
- [ ] Unsupported source is stable and source-located; missing planned support
      or backend adapters are fatal Invariants and never demote.
- [ ] IR-only, async regression, cold standalone/WASI, cross-backend, validity,
      typecheck/format, and merge-group Test262 gates are net-non-negative.

## Deletion boundary

R7 may remove async-specific AST planning, activation, and direct routing only
after every named migrated container is Prepared with
`legacyBodyEmitted:false`. It does not delete general shared
`compileStatement`/`compileExpression` handlers still used by hybrid non-async
units. It retains `async-scheduler.ts`, frame-core, Promise, iterator, and
settlement provider behavior behind #3526 intents. General deletion is R10.

## Out of scope

- A parallel CPS/frame engine or a second plan for linear.
- Encoding AST, lexical names, concrete Wasm types/indices, or callbacks in the
  plan as a temporary bridge.
- Treating top-level await as supported without an explicit ordered module-plan
  extension.
- Preserving current raw-T/await-elision behavior when it violates Promise and
  microtask ordering.

## Risks and mitigations

- **Observable timing/ABI correction:** canonical Promise ABI changes current
  sync pass-through behavior. Use event-order tests, not only return values.
- **Abrupt completion:** catch/finally and generator return/throw are easy to
  miscompile. Represent completion/unwind edges explicitly and verify them.
- **Spill representation drift:** current derived-param/ref guesses depend on
  legacy contexts. Use SSA/ref-cell identity and `IrType` before deleting them.
- **Late imports/indices:** current AST census exists to prevent shifts. Require
  #3526's frozen Promise/iterator/scheduler manifest before resume emission.
- **Carrier coupling:** one unsupported async generator may currently change a
  module. Make Unsupported unit-local and test unrelated plan hashes.
- **Protocol/cross-file gaps:** iterator close, `yield*`, laziness, operation
  Promise identity, same-name units, and declaration order need dedicated
  anti-vacuity traces rather than corpus counts.

## Implementation Plan — 2026-09-05 — B2 linear suspension chains and liveness

**Planning source:** `5da655f286fcd569203cd2012b23dc21bf1c626d`; the lead
verified no IR delta in the subsequently fetched `4946cf` main. Re-ground the
implementation against its assigned current-main worktree. Proposed slice
claim: `3527:r7-b2-linear-suspension-liveness`, reserved by the lead before
dispatch. Astra plans and Luna `max` implements, per the user. This phase is
ready independently of the remaining epic dependencies; it does not close R7
or change its acceptance checkboxes.

### Current production boundary

The older “Current IR does not represent suspension” evidence above is
superseded by production source. `IrAsyncPlan` already has a canonical Promise
ABI, typed spills/updates, verifier and full semantic serialization.
`src/codegen/ir-async-frame.ts:388` lowers it through the existing
`emitPreparedAsyncFrameStateMachine`; its adapter restores typed spills
(`:322`) and consumes multiple states. A new frame engine or plan schema is
not required for linear chains.

The producer still constrains the population. `async-prepare.ts:745` handles
one await and rejects a slot used on both sides; its continuation receives
only the resumed value. The separate loop and two-await producers test
`fetchAllSequential`/`fetchUser` and `main` names (`:139`, `:373`). Source
selection independently admits exact forms and rejects pre-await captures
(`async-ir-planning.ts:445`, `:507`); native admission follows another named
family (`:565–650`). None of those names is a semantic suspension proof.

There is also an earlier blocker: the await arm in `from-ast.ts:4044` erases
statically settled `Promise.resolve` and non-reference awaits. A general
splitter cannot recover an erased microtask boundary. Exact prepared-owner
await evidence must reach this arm before source admission widens.

### Bounded structural result

Prepare top-level ordinary async declarations with a linear sequence of
awaits, ordinary intervening computation, and a final return/void completion.
There is no fixed await count, statement count, identifier spelling, constant,
or particular callee required. Use the existing callable/frame carrier and
runtime-provider capabilities; this phase does not widen their representation
vocabulary. At least the existing real-suspension population must be covered,
and every await within an admitted chain survives, including settled operands.

Branches/back-edges that cross suspension, try/catch/finally, nested executable
containers, receivers/captured ref cells, `for await`, async generators, WASI
and cross-source ownership remain separate phases. Existing specialized
loop/main routes remain until the generic producer plus their runtime
capabilities can replace them with measured parity. Their remaining name
guards must be reported as unfinished work, not described as general R7
coverage. Fully settled owners still using the old C-1 route are likewise
outside this phase's completion claim.

### Implementation and exclusive write scope

1. **One exact source eligibility record.** Add
   `src/codegen/async-linear-planning.ts` and consume it from `async-ir-planning.ts` in
   `preparedIrAsyncSourceShape`, `prepareAsyncCallableAbi`, selector options,
   thenable-call resolution and owner collection. Reuse `analyzeAsyncBody`
   and `planLinearAwaits` (`async-cps.ts:659`) only as frontend structural
   preflight; retain every exact await node in source evaluation order and
   prove none is hidden in a nested scope/unsupported control region. Do not
   copy their AST/callback plan into `IrAsyncPlan`. Source eligibility,
   allocated canonical Promise result ABI, and final IR preparation must
   agree; an unproved callable must not be changed to a Promise ABI and then
   fall back to a raw-value emitter.
2. **Preserve suspension at AST lowering.** Extend the prepared resolver in
   `src/ir/async-from-ast.ts` with exact owner/await-site evidence and the
   prepared resume type. Consume it only in `from-ast.ts`'s await arm, before
   C-1 await elision. Evaluate the operand once, retaining an explicit `await`
   even when an existing valid static substitution supplies its value. Use
   the existing typed externref conversion when the operand needs the await
   carrier; provider preparation must see that conversion. Do not add an
   extra reaction or hand-written Promise wrapper: the existing frame engine
   owns PromiseResolve/adoption and suspension. Reconcile the produced await
   population with the exact source record; a missing, duplicate or foreign
   site is an invariant, not a shorter successful plan.
3. **General IR segmentation.** Add `src/ir/async-linear-prepare.ts`, called
   from `prepareSuspendingIrFunction:678`. Consume one linear IR block with
   no suspension hidden in nested buffers; split at every await, in order.
   Retain the existing return-carrier optimization only after this general
   analysis proves it valid. Do not use owner/callee/local names as admission.
   Produce deterministic state IDs and `ir-async-state` derived `UnitId`s
   anchored to the exact source owner and stable helper ordinal.
4. **Compute values crossing boundaries.** Build a complete definition/use
   and type table. Resolve ordinary linear `slot.write`/`slot.read` sequences
   through reaching definitions before splitting; preserve explicit
   conversions and logical types. A read without a proved reaching definition
   or a refinement that cannot be preserved is a typed preparation refusal,
   never an invented default. Compute live-in/live-out backwards over the
   resulting state edges, excluding the successor-defined resume value.
   Retain a value through intermediate states even when they do not use it;
   omit dead values and overwritten slot versions. Populate exact typed
   `spills` and each suspend's `live` set. Reuse the existing analysis
   vocabulary and have `verifyIrAsyncPlan` (`async-plan.ts:1107–1171`)
   independently recompute the result from the completed plan.
5. **Outline computation into ordinary IR helpers.** The current frame
   adapter intentionally accepts `const`/`call` state bodies
   (`ir-async-frame.ts:230`); do not expand it into another instruction
   lowerer. Partition non-suspending computation into deterministic ordinary
   helper calls with explicit free-value parameters and zero/one result,
   as the existing async producers do. A region with several values needed
   later must expose each value through ordered helper boundaries; returning
   only its final Promise loses the others. Never recompute effectful
   prefixes to manufacture extra outputs. Preserve instruction order,
   effects, allocation/site provenance, and exact symbolic call bindings.
   Keep intermediate values inside helpers where their carrier is not a
   valid frame boundary. Every helper and its final allocation provenance
   must pass the ordinary IR verifier before component sealing.
6. **Reuse canonical target preparation.** The semantic chain uses
   `canonicalPromiseAbi`, `createIrAsyncPlan`, the existing runtime intents,
   and rejection edges to the existing rejection sink. Numeric/reference
   spills and helper interfaces must have exact preplanned carrier evidence.
   For standalone, replace named-leaf certification for the new chain with a
   structural call/provider closure: each awaited Promise producer is an
   exact prepared async owner or an already-supported Promise-delay/provider
   plan. Reconcile the whole candidate dependency component before reserving
   ownership, independent of declaration order. Unknown producer/carrier
   provenance remains a refusal. Do not enable the global native Promise
   carrier gate, import host services into standalone, or let one unsupported
   sibling poison unrelated prepared components.

Own the new `src/ir/async-linear-prepare.ts` and `src/codegen/async-linear-planning.ts`,
`src/ir/async-prepare.ts`, `src/codegen/async-ir-planning.ts`,
`src/ir/async-from-ast.ts`, and only the named await arm/import in
`src/ir/from-ast.ts`. A small pure liveness extraction from `async-plan.ts`
is permitted if useful; do not weaken its verifier or change the codec/schema.
Add `tests/issue-3527-linear-suspension-preparation.test.ts` and
`tests/issue-3527-linear-suspension-runtime.test.ts`, updating old near-miss
expectations only after their new route is measured.

R2-B1 owns `lower.ts`, `integration.ts`, source-callable registry, and component
sealing; this slice reuses those seams and does not edit them. R5 M2-P1 owns
`multi-prepared-*`; this slice does not touch those files. Ordinary async
callable allocation stays in `prepareAsyncCallableAbi`; any required shared
boundary change must be coordinated with the R2 owner before editing. No
changes to `async-frame.ts`, scheduler, runtime adapters or new providers are
assumed: a missing capability is a concrete prerequisite to report, not a
reason to bypass preparation or silently widen a backend.

### Validation and landing bar

- First measure baseline/candidate SHAs and explicit target/options. Include
  two and three awaits with a parameter and a computed value live across
  both, a mutable local updated between awaits, dead/overwritten values,
  numeric-vector identity, an unused await result, and final `return await`.
  Vary names, constants, helper declaration order and await count. Compare
  exact attempted units, state/await counts, helpers, spill sets, direct/IR
  body counts and runtime results. No gain is asserted from source inspection.
- Use controlled pending fulfillment and rejection at each suspension. Assert
  the event order before the first call returns, between resolutions, and
  after final settlement; a rejected first await cannot run later effects or
  evaluate the second operand. Test a synchronous throw while evaluating an
  awaited expression and after a resume. Add a mixed pending/settled chain
  containing `await Promise.resolve(value)` and a settled non-thenable; every
  admitted await must still yield a microtask. Compare with native JavaScript
  and the direct engine control, documenting any baseline ordering defect.
- Corruption tests remove/add a live value, use an old slot version, drop or
  duplicate an await, substitute a source owner, and remove a runtime/carrier
  receipt. Missing liveness, invalid provenance or post-claim evidence must
  fail before publication; deliberately unsupported control regions retain
  a source-located refusal and do not emit a partial prepared body. Poison
  the direct body of newly prepared owners and require direct `0` / IR `1`.
  Revert the generic producer and prepared-await retention independently to
  prove both ownership and ordering tests fail for the intended reason.
- Run `pnpm typecheck` and
  `VITEST_MAX_FORKS=1 node node_modules/vitest/dist/cli.js run` with the two
  new suites, `tests/ir/issue-1373b-async-plan.test.ts`,
  `tests/issue-4104-ir-async-plan-runtime-consumer.test.ts`,
  `tests/issue-4106-ir-async-fetch-user.test.ts`,
  `tests/issue-4124-ir-final-async.test.ts`,
  `tests/issue-4573-standalone-native-promise-delay.test.ts`,
  `tests/issue-4574-standalone-native-async-family.test.ts`, and
  `tests/issue-2906-async-multiawait.test.ts`. Run native controls in fresh
  processes; also retain host rejection/engine-convergence and existing WASI
  controls as no-regression evidence, not newly prepared WASI coverage.
- Run both `node --import tsx scripts/check-ir-only.ts --json --policy=hybrid`
  and `node --import tsx scripts/check-ir-only.ts --json --policy=ir-only`,
  `node --import tsx scripts/check-ir-fallbacks.ts`,
  async equivalence, normal dialect/layering/format/size gates and full
  merge-group Test262. Report remaining fixture producers, C-1 await elision,
  unsupported containers/handlers and target gaps explicitly. A green
  playground family or the small IR-only corpus cannot close this issue.

### B2 implementation checkpoint — 2026-09-05

The B2 implementation is published in signed merge head
`873e5fa140f65040bab224a1d147582a55a615c9`, whose parents are the signed B2
implementation `a8bc547795f47ec0847466b0bb0ebb5a75cb01f8` and current upstream
`470ceba797a2822ead2a4060fc65fb78c0b52887`. The branch is
`codex/3527-b2-luna-20260905`; PR #5602 is open against `loopdive/js2:main`
from `ttraenkler:codex/3527-b2-luna-20260905`.

The structural source record and AST free producer now admit arbitrary positive
await counts in supported top level straight line async declarations. The
runtime fixture measures five source awaits and five emitted frame state edges:
pending `delay`, settled `Promise.resolve`, an unused settled
`Promise.resolve`, settled non thenable `await 42`, and a second pending
`delay`. The IR and native controls both produce the event sequence
`schedule:0:1`, `fire:0`, `observer:1`, `observer:2`, `schedule:0:1`,
`fire:0`; the independent Promise observer distinguishes retained settled
awaits from static erasure. Controlled first and second rejection cases stop
later state effects, and final void owners resolve `undefined` through the
canonical ABI. The direct engine value comparison remains supplemental.

The pure preparation suite verifies three states/two suspensions, computed
SSA liveness `[[0], [0, 4]]` with SSA spills `{0, 4}`, mutable slot reaching
definitions with slot spill `{3}`, and verifier refusal of missing liveness,
missing spills, duplicate states, and missing runtime intent. The direct body
poison control observes direct `0` / IR `1` for newly prepared owners.

Post merge validation: the two B2 suites passed 10/10 tests and the adjacent
async plan suite passed 12/12. Typecheck, format, fallback, IR only hybrid and
IR only, dialect, neutrality, layering, stack, host import, LOC/function,
oracle/coercion, numeric local parity (18/18), issue integrity, and normal
pre push checks passed. The focused #4106 suite passed 7/8 with its existing
host free invalid `WebAssembly.validate` baseline red; the #4104 suite passed
16/17 with its existing `functionPrototypeCall` policy expectation red.

This checkpoint does not close R7. Loops/back edges, handlers, nested
executable containers, async generators, `for await`, WASI, and fully settled
owners on the historical C 1 route remain separate work. Existing standalone
and WASI invalid opcode validation reds remain unchanged, and no baseline was
weakened.

### B2 settled owner admission repair checkpoint — 2026-09-05

Root's independent settled await controls found a regression at the published
B2 head before this repair. With `experimentalIR: true`,
`nativeStrings: false`, and `trackIrOutcomes: true`, the one await literal
owner and the two await literal owner both failed compilation with
`IR async runtime attachment for test has no valid async plan owner`. One
direct body was emitted before the fatal IR error, and the result had zero IR
bodies. The historical C 1 controls returned 43 and 85. The provider only
`Promise.resolve` control remained a
valid B2 owner and returned native Promise value 6 with matching independent
native observer order.

The narrow fix makes prepared await retention require the existing
potentially suspending owner analysis in addition to the linear source shape.
Fully static owners therefore remain on their established C 1 route until a
separate cutover, while provider only and pending mixed chains retain the B2
producer and canonical await ordering. The regression suite independently
asserts that both static owners' synthetic helpers are absent, then validates
their direct results 43 and 85; the existing mixed, pending, rejection, and
provider controls remain active.

Repair commits `96defcfe84d9753e5352e20b60a0c86236f5dda0` and
`18352307cb7cb6bede526bf496e10ba3846624d7` are signed with the required
Thomas Tränkler author, Codex coauthor, and Luna Max model trailer. PR #5602
is open and unqueued at exact head
`18352307cb7cb6bede526bf496e10ba3846624d7`.

The focused runtime regression suite passed 7/7 and the pure preparation suite
passed 4/4. Typecheck, formatting, fallback, IR policy, dialect, layering,
neutrality, stack, oracle/coercion, numeric local parity (18/18), issue
integrity, and the normal pre push hooks passed. Root independently reran the
three source controls 3/3: static one and two await owners compile and return
43/85 with the baseline route, and the provider only owner remains direct 0 /
IR 1 with native observer parity. The exact upstream merge head still needs to
be integrated before the final R7 publication review; this repair does not
close R7 or broaden its remaining loop, handler, container, generator,
`for await`, WASI, or settled owner limits.

## Implementation Plan — 2026-09-05 — B3 settled non-thenable owners

**Next bounded cutover, conditional on final B2 author handoff.** Canonical
claim `3527:r7-b3-settled-nonthenable-owners` is held by
`ttraenkler/luna-ir-r7-b3-20260905` for branch
`codex/3527-b3-luna-20260905`. Root prepared its isolated worktree at verified
published B2 repair head `76fb2f31258ec90aef96aa81fe287e285a6a7221`.
The preceding B2 implementation and repair records are preserved from that
exact head. The complete ten-open-PR file census and canonical claims read at
`a7a7a28affed7db816f1a645d4e4fc8ad21a207d` found no duplicate B3 slice.
Astra plans; Luna Max implements after root records the author's completed
current-main integration and releases the final source handoff. Worktree
creation alone is not implementation dispatch or proof that B2 has merged.

### B2 repair prerequisite and source cause

Root ran five isolated GC/JS-host rows with `experimentalIR:true`,
`nativeStrings:false`, `trackIrOutcomes:true`: two fully literal one/two-await
sources at each of B2 and planning head
`a5fbaa544046f854daba8881d80c72bc56b87bf9` (source equals main `470ceba`), plus
one B2 `Promise.resolve(parameter expression)` positive control. Main's two
literal sources compiled/validated and returned raw numbers `43`/`85` (2/2).
B2's same two sources failed compilation (0/2), reporting
`IR async runtime attachment for test has no valid async plan owner`. Its
positive control compiled and returned a real Promise fulfilled with `6`, with
native observer ordering. Artifacts: root scratch `r7-settled-*.jsonl` under
`.tmp/ir-completion-20260905` and the corresponding probe script. These results
establish a B2 regression for those two controls, not a complete async census.

The original B2 author owns its narrow repair. Do not repair it again in B3 or
claim the old C-1 population remained unchanged before the repaired head passes.
Root subsequently verified three repair controls (3/3) on local candidate HEAD
`96defcfe84d9753e5352e20b60a0c86236f5dda0` plus final comment edits, with
`async-ir-planning.ts` SHA-256
`d84b1bc8252361afcdd9c5ac3cd67750f0950f220fa954d5e45875296b124ead`
stable across the runs. The literal sources again compiled/validated and returned
raw `43`/`85`; the provider control retained direct `0` / IR `1`, a real Promise
fulfilled with `6`, and native observer ordering. Outputs are
`r7-settled-{one,two,provider}-fix.jsonl`. This verifies the narrow regression
repair locally. The original author subsequently reports 7/7 runtime and 4/4
pure-preparation controls plus normal gates passing. Root's complete PR file
census independently confirms published head `76fb2f3` with the eleven intended
files, including the repair and its record. Current-main integration and the
final B2 author handoff remain prerequisites for B3 implementation.
The source discrepancy is exact: `preparedIrAsyncAwaitSite`
(`async-ir-planning.ts:759`) checks a linear source shape/site, while
`preparedIrAsyncSourceCanSuspend:551` additionally requires a non-static await.
Consequently retention can run for an owner absent from
`collectPreparedIrAsyncOwners:970` and without an `IrAsyncPlan`. B3 must inherit
the repaired ownership guard, not remove it to gain coverage.

Other decisions that must move together:

- `prepareAsyncCallableAbi:869`, called by `declarations.ts:1856/2995`, projects
  `externref` only for the prepared source proof. Otherwise the declaration
  retains the unwrapped fulfillment ABI. `isAsyncIrReady`
  (`ir/async-selection.ts:26`) still admits historical C-1 owners separately.
- `preparedIrAsyncSourceShape:511` prioritizes the old one-await identity source
  shape. A settled `return await ...` must receive exact retained-await evidence
  even when that source-shape priority would otherwise select identity.
- `selectR3PreparedSuspendingAsyncFunctions`
  (`ir-prepared-free-functions.ts:1203`) joins exact owners, allocated Promise
  signatures and outgoing prepared dependencies. It does not by itself prove
  every incoming source consumer compatible with a changed Promise ABI.
- `prepareSuspendingAsyncLowering` (`ir/integration.ts:476`) splits only the
  recorded owner set. `prepareSuspendingIrFunction` (`ir/async-prepare.ts:679`)
  already tries the one-await optimization before B2's generic splitter.
  `lowerPreparedIrAsyncFunction` (`codegen/ir-async-frame.ts:365`) verifies the
  allocated `externref` result and drives the existing frame engine.

### Integrated B3 baseline verification — 2026-09-05

The original B2 author integrated exact main
`e4ef2c3ef01cc04126203551240fe95b3513f92e` in signed merge
`d658f8964b1fd106f28a243e273211db968afaac`, whose other parent is the
published repair `76fb2f3`. The B3 planning worktree contains that merge and
has identical source and test contents; its only additional change is this
Astra plan. The author's post-merge gates, safe publication and final handoff
remain separate dispatch prerequisites.

Root reran the same three controls in separate GC/JS-host processes at exact
`d658f896`, including the merged integration, lowering and R3-routing files
in the seven-file before/after fingerprint check. All three controls passed
(3/3): the one/two literal-await exports compiled and validated, returning
raw `43`/`85` with direct `1` / IR `1`; the prepared provider export returned
a real Promise fulfilled with `6`, direct `0` / IR `1`, and exactly the native
observer event sequence. The two raw-value results preserve the repaired
baseline and still contradict the required canonical Promise ABI; they are
not B3 acceptance evidence. No conformance population is inferred here.
Evidence is in root scratch `r7-settled-{one,two,provider}-postmerge.jsonl`
and `r7-settled-runtime-postmerge-control.mts`.

### Scope and ordered implementation

Own top-level ordinary async free functions on the existing JS-host WasmGC
provider profile, with B2's flat source/control proof, existing supported
parameter carriers, numeric awaited values and numeric/void fulfillment. Every
await operand must have exact non-thenable evidence after transparent wrappers
are removed. This is a semantic proof, independent of spelling, constants,
source-file identity or an await-count limit. A function with no await needs a
separate entry/settlement plan and remains outside this increment. Keep loops,
handlers, nested executables, methods, generators, `for await`, standalone/WASI
and new carrier families on their existing policies.

1. **Prepare one exact owner proof before ABI projection.** Extend the existing
   async source planning with an explicit settled-owner record containing source/
   unit/declaration identity, ordered await sites, their actual operand and
   delivery types, fulfillment signature, and existing number-box/unbox and
   async-runtime capability requirements. Reuse `preparedIrAsyncLinearSource`
   and the ordinary selector's body/signature proof. Unknown evidence is not
   non-thenability; a cast of a Promise/unknown value to `number` is not proof.
   Do not use the old static classifier's scheduling-elision verdict as the
   authority. Parameters, helpers and retained calls must use their existing
   supported ABI, with the existing exact function-value exclusions.
2. **Close the callable boundary before changing it.** Join incoming and outgoing
   source call sites by UnitId and require the selected declaration's canonical
   Promise result to agree with each prepared/direct call contract. Preserve
   numeric fulfillment separately from the physical callable `externref` result.
   External JS callers receive the real Promise; old source raw-value/await
   consumers cannot be assumed compatible. If an existing caller contract cannot
   express this distinction, leave the affected component unadmitted before ABI
   projection and identify the required caller-contract prerequisite. Do not
   broaden the R2 transaction or infer compatibility from a bare function name.
3. **Use that same proof at every handoff.** Declaration ABI projection,
   selection, the repaired `preparedAsyncAwaitSite` guard, collected owner IDs and
   final R3 routing must agree. Unselected owners receive neither the new ABI nor
   retained awaits. Once a Promise ABI has been promised, losing its prepared
   owner must be an Invariant or a proven rollback before any consumer/ABI
   publication; falling back to the old C-1/direct body is invalid because its
   activation predicate still declines settled owners. Do not globally enable
   `asyncFnNeedsHostDrive` or change legacy activation for unrelated functions.
4. **Retain and split the actual operands.** For these non-thenable sites, evaluate
   the source operand once, use B2's existing carrier conversion and emit one
   `await` per site. Reconcile the exact ordered source sites with final IR awaits
   before splitting. Reuse B2 liveness, slot reaching definitions, derived-unit
   provenance and `canonicalPromiseAbi`; do not add a second state builder.
   Preserve `prepareSingleAwaitIrFunction`'s proven carrier optimization before
   the generic splitter. Optimizing carrier conversions must retain the await
   edge and its job boundary.
5. **Prepare providers, seal, then emit.** Use the existing runtime manifest and
   `materializePreparedAsyncHostAdapters` to reserve number boundaries, Promise
   resolve/react/capability/settlement and void-undefined support before component
   seal. Validate final logical/physical signatures, helpers, state/spill/await
   census and exact runtime receipts before the source slot is published once.
   The exported Wasm function itself returns a real Promise. A call-site
   `Promise.resolve` wrapper cannot be used to hide a raw result. Unknown support
   is a pre-ownership refusal; broken promised evidence is an Invariant with no
   partial body publication or direct retry.

**Promise.resolve is an explicit dependent proof.**
`staticPromiseResolveSettledExpr` (`ir/async-static.ts`) recognizes textual
`Promise.resolve` chains without binding or mutation evidence. Both the C-1
selector and B2's prepared-await arm reuse it (`select.ts:9319`,
`from-ast.ts:4058/4073`). A nonempty declaration-file check alone does not prove
an unmodified builtin property or justify erasing a callable evaluation.
Promise-valued operands therefore do not qualify for B3's non-thenable proof.
Their next increment must either evaluate the original call exactly once with
its resolved callable/receiver/effects and Promise carrier, or supply a sound
immutable-builtin substitution proof covering aliases, shadowing, mutation,
getters and nested calls. No new name-only substitution is permitted here.
The current host async normalization itself uses `Promise_resolve`
(`runtime-host-capabilities.ts:589`, `runtime.ts:16250`); distinguish that
intrinsic-await obligation from the source-visible static call when planning the
follow-up. Do not call this separate existing hazard a B2 regression without a
controlled baseline. Existing B2 Promise-valued owners remain on their current
policy; this phase does not certify or broaden them.

### Finite validation and ownership

Use the repaired B2 head as the measured base and record its exact SHA. Add
`tests/issue-3527-settled-owner-runtime.test.ts` and focused owner-proof negatives:

- Real exported functions with one and multiple numeric/non-thenable awaits,
  a parameter/computed value live across both, mutable-local updates, unused
  await results, `return await`, and a void tail. Vary names, constants and
  helper order. Check raw export return is a native Promise, expected fulfillment,
  exact await/state/liveness evidence and direct `0` / IR `1` per admitted owner.
- Native-JS controls with independent `Promise.resolve().then(...)` observers
  and observable effects before the first await, between awaits and after the
  last. Compare the full event sequence, including what happens before the call
  returns. Awaiting a raw number in the test harness is not Promise-ABI proof.
- A supported effectful call that throws before the first await and after a
  resume must return a rejected Promise, never throw out of the exported call,
  and must stop subsequent effects. Use controlled host imports/helpers with
  matching native controls. Retain B2's controlled first/second awaited rejection
  tests as adjacent engine coverage; those Promise-valued inputs are not new B3
  admission evidence. A raw cast consumer is not a compatibility oracle.
- At least one closed prepared caller of a new owner, plus an incompatible
  historical raw-value caller and a same-spelling foreign binding. Verify exact
  Promise call ABI or refusal before projection, never a wrong executable.
- Delete/substitute the owner proof, a source await, spill, helper provenance or
  runtime/ABI receipt; withdraw the owner after Promise projection; poison the
  source direct/C-1 body and the unprepared await arm for admitted owners.
  Corruption must fail before publication. Unselected and kill-switch controls
  keep their existing route and ABI; empty/no-await input cannot satisfy the
  positive denominator. Preserve the existing one-await optimization checks.
- Shadowed/aliased/mutated `Promise.resolve` and cast thenables must not gain the
  new settled-owner proof. Compare main/repaired-B2 controls where practical;
  report any existing failure separately rather than changing a baseline.

One Luna Max worker owns only the relevant owner-proof/ABI/await-site functions
in `codegen/async-ir-planning.ts`, the source-proof helper in
`codegen/async-linear-planning.ts`, the exact proof fields in
`ir/async-from-ast.ts` and their prepared-await consumption in `ir/from-ast.ts`,
plus focused tests and this issue record. Existing declaration call sites,
selector, splitters, runtime providers and frame engine should consume the
shared proof without redesign. If needed, a narrow change to the R3-specific
functions `r3SuspendingAsyncSignatureMatchesAllocatedSlot` /
`selectR3PreparedSuspendingAsyncFunctions` requires the lead to confirm the
R2 worker's file ownership is clear. No changes to R2 sealing/publication,
P2A initializer transactions, R8, broad `codegen/index.ts`/`ir/integration.ts`
lifecycle, or the legacy activation engine are authorized by this slice.

Run `pnpm typecheck`; the new suites; both B2 suites; the adjacent
`tests/ir/issue-1373b-async-plan.test.ts`; the existing #4106 one-await,
#4104 runtime-consumer, #4124 final-async and #2906 multi-await suites; and
standalone/native-async controls as no-regression evidence. Run
`node --import tsx scripts/check-ir-only.ts --json` in both hybrid and IR-only
policies, `node --import tsx scripts/check-ir-fallbacks.ts`, plus the repository's
applicable async-equivalence, layering/dialect/format/size gates. Record exact
baseline/candidate denominators and existing reds; the earlier B2 checkpoint is
not a substitute for fresh validation. No new pass count is asserted here.

This removes C-1 only for owners carrying the new complete proof. Promise-valued
settled operands, no-await async functions, remaining containers/carriers and
caller-contract gaps remain explicit follow-ups. R7 and full #3518 retirement
acceptance remain open.

### B3 implementation record — 2026-09-05 — Luna Max

B3 implementation is present on the settled-owner slice in
`async-linear-planning.ts`, `async-ir-planning.ts`, `async-from-ast.ts`, and
`from-ast.ts`. The source proof now requires one exact top-level linear owner
carrying checker-backed numeric, non-thenable evidence for every await operand.
Its immutable receipt is owned by the planning `UnitId`/`SourceId`, freezes the
ordered await sites and facts, and records incoming/outgoing source callable
UnitIds. The declaration ABI gate, selector gate, retained-owner collection,
R3 acceptance input, and prepared await resolver all consume the same cached
receipt; a stale or withdrawn issued receipt raises
`selection-preparation-mismatch` before a direct body can retry. The prepared
await handoff carries the receipt owner and source fingerprint, and AST lowering
retains the original numeric operand exactly once. Existing `Promise.resolve`
substitution and cast/unknown refusals remain on their prior policy.

Measured integrated B2 baseline is `d658f8964b1fd106f28a243e273211db968afaac`:
the repaired fully literal one/two-await controls returned raw `43`/`85` with
direct `1` / IR `1`, while the Promise-valued provider control returned a native
Promise with direct `0` / IR `1`. On the B3 candidate, literal one/two-await,
single and multiple settled owners, `return await`, void-tail, and a numeric
helper call all return native Promises with direct `0` / IR `1`; the settled
three-await owner resolves to `192` and preserves the observed native sequence
`after-call:1`, `observer-1:2`, `after-flush-1:2`, `observer-2:3`,
`after-flush-2:3`, `after-promise:4`. A closed prepared caller resolves to
`42`. The raw-value consumer withdraws the owner before ABI projection; the
same-spelling foreign callable binding, Promise/unknown casts, shadowed
`Promise.resolve`, no-await, and standalone static controls receive no B3
receipt. A forced owner-proof withdrawal after ABI issuance fails before state
publication with the invariant above.

The focused B3/runtime and adjacent preparation denominator is `33/33`: new
settled-owner runtime `10/10`, existing linear runtime `7/7`, linear preparation
`4/4`, and the adjacent async-plan suite `12/12`. TypeScript typecheck also
passes. The broader requested async controls retain environment/base reds: the
six-file #4106/#4104/#4124/#2906 run was `34` passing and `21` failing; #4104
has its existing standalone `functionPrototypeCall` policy mismatch, #4106's
standalone host-free binary row is already false on the baseline, #4124's child
`tsx` process is blocked by the sandbox `listen EPERM` pipe, and the #2906 WASI
rows fail `WebAssembly.validate` under this local runtime. No local full
test262 run was attempted. Broader R7 ownership, Promise-valued operands,
no-await owners, remaining caller contracts, and CI acceptance remain open.

The branch first recorded the signed current-main refresh at
`9cc5826906db09eacf9007b7faf3b9bb02d207d5` and then integrated fetched current
main `b67ab1fc0eb2bafe959c3100df6e68d03325ce4f` in signed merge
`04b4a59dbf19c9fa61e8e01ec2ad6bd192cedc1b`. The fresh ten-file async matrix
on that candidate was `67` passing / `34` failing (`101` total): the B3,
linear, preparation, and async-plan files remained green; the retained failures
were #4104 `1`, #4106 `1`, #4124 `1` (sandbox `tsx` IPC), #4573 `11`, #4574
`14`, and #2906 `6` (standalone/WASI `WebAssembly.validate` environment
controls). The direct `node --import tsx` forms of the harness, stack-balance,
and codegen-fallback checks passed after their `npx tsx` forms hit the sandbox
IPC pipe restriction. The repository-wide dead-export, any-box, and
speculative-rollback scripts resolve the space-containing worktree as an
encoded `%20` path; the JSR package budget has no local `dist` artifact; and
the godfile check reports 44 current-main regressions outside this slice.
These are recorded gate/environment residuals, not B3 acceptance evidence.

The scoped B3 source, tests, and measured record are committed in
`7c60d5c5873d0b164f1aa99b85b2995897fe8233` on top of the signed current-main
merge above.

### B3 issuance-integrity repair — 2026-09-05 — Luna Max

The post-ABI proof-loss follow-up keeps issuance evidence independent of the
current identity maps. `settledOwnerIssued` is now keyed by compilation
context and original `FunctionDeclaration`, retaining its original UnitId,
SourceId, and source file. An issued declaration cannot mint a receipt under
a rebound UnitId or rebuild one after its original cache entry is withdrawn;
`forgetPreparedIrAsyncSettledOwner` also locates the original UnitId after
current identity lookup fails. The source-suspend and prepared-await guards
check issuance before source-shape admission, so a missing shape remains an
Invariant instead of a quiet refusal or direct fallback.

The three real identity controls all begin with a positive receipt and
externref ABI projection, then mutate copied identity maps: declaration-to-unit
deletion, terminal deletion, and declaration rebinding to the sibling UnitId.
Each retains `WasIssued=true`, returns no current receipt, and raises the
`selection-preparation-mismatch` proof-loss error from source suspend, await
site, and ABI projection. A fourth control removes the current function body
after issuance and raises the same error before either handoff can return.

The end-to-end identity-loss control uses a narrow Map-read fault after the
first receipt is issued. It returns `success=false` with one
`selection-preparation-mismatch` invariant, `legacyBodyEmitted=false`,
`irBodyEmitted=false`, zero direct/IR body counters, and no async state
function. Thus the promised externref slot is not published with a raw f64
body or a direct retry. Focused B3 runtime is **15/15**; B3 plus the adjacent
linear preparation/runtime controls are **26/26**. `pnpm run typecheck`,
Prettier checks, `node --import tsx scripts/check-ir-only.ts --json` (both
single-host and standalone, 5/5 entries, 38 emitted, 0 Unsupported, 0
Invariants, 0 legacy bodies), and `pnpm run check:ir-fallbacks` pass. The
broader R7, Promise-valued operand, remaining caller-contract, and CI gates
remain open as recorded above.

## Implementation Plan — 2026-09-05 — Astra async integration repair

The user now prioritizes consolidating the existing migration pieces before
opening another feature slice. B2 and B3 must form a coherent validated async
change; separate local successes do not satisfy their dependency relationship.
Parent Astra owns this plan and review. The same Luna Max async owner implements
the repair in the preserved B3 worktree, retaining signed checkpoint
`44694026163cee6c38eea890a6df263234d93a62` before further source changes.

### Concrete CI evidence and source boundary

On published B2 head `df4b8b86ca2620607a6470428d509cba5aea61bb`, CI run
`33976818803` finished with a failing quality job, equivalence shard 5, and its
aggregate gate. The shard reports one new regression:
`tests/equivalence/ir-slice10-promise.test.ts`, async-to-async cross-call.
The source contains an async `inner` with no await, an `outer` with two awaits
of `inner`, and a synchronous exported caller casting `outer(5)` to number.
The existing C1 no-await declaration can retain numeric fulfillment ABI; an
async TypeScript return annotation alone is not proof of a physical Promise.
A generic B2 producer can encounter this boundary without issuing B3's
all-settled receipt, so repairing only that receipt's callers is insufficient.

The quality failure is separate evidence: the host-free control in
`tests/issue-4106-ir-async-fetch-user.test.ts` reports a successful compilation
whose binary fails `WebAssembly.validate`. Root is measuring both controls
against freshly fetched main `b1537bbeca3858faf45fd89eff5506d21d1e230f`.
Do not infer that the two failures share a cause, or declare the host-free
failure harmless merely because it was seen on an earlier baseline.

### Implementation order

1. Trace the generic owner's actual ABI projection, selection, source proof,
   await retention and final prepared admission. Enumerate all consumers of
   the shared shape/capability helper before changing it. Preserve existing
   single-await, timer, Promise provider and counted-loop behavior.
2. Close outgoing source calls by exact declaration and UnitId against the
   carrier their declaration will actually publish. A known C1 no-await async
   callee with numeric ABI does not satisfy a Promise-carrier demand. Reuse
   authoritative prepared/source ABI evidence; a name, `Promise` annotation,
   or later numeric cast is insufficient. Unknown evidence must decline
   before projection rather than silently accept an empty caller census.
3. Close incoming source calls before promoting a generic owner. Distinguish
   a proved Promise carrier or compatible prepared await from a raw numeric
   consumer, unowned call site, function-value escape or unresolved target.
   Retain complete source identities and exact call contracts. If multiple
   candidate owners depend on each other, settle their component before ABI
   publication; do not make correctness depend on declaration order or a
   recursive predicate's optimistic partial result.
4. Keep eligibility refusal before any Promise declaration or body-skip
   promise. After issuance, loss or contradiction of the retained contract
   must remain an invariant, using the identity-loss repair already committed.
   Do not recover by rebuilding a different proof, restoring raw C1 output,
   or disabling the whole generic producer to satisfy one fixture.
5. Run the exact failing cross-call control with a real compatible Promise
   chain as its positive control. Check compilation, binary validity, runtime
   result/Promise behavior and terminal ownership, not only byte counts.
   Preserve legacy behavior for a relation this increment explicitly declines;
   no-await async semantic migration remains outside the current repair.
   Include declaration-order and post-projection contradiction controls when
   they exercise the changed join. Do not weaken equivalence or Test262 baselines.
6. Diagnose the host-free validity failure independently using the fresh-main
   observation and concrete validation error. If it is already fixed by the
   fetched dependency, retain that source/byte evidence. Otherwise report the
   smallest actual missing carrier/resource contract before touching another
   subsystem. Do not skip or weaken the control merely to publish B2.
7. Return a signed clean candidate with focused checks and updated evidence.
   Root composes it with the repaired initializer and linear handoff candidates
   and runs the larger public-compiler path. Preserve B2's public main merge
   and B3's automatic public update. No force push, queued-head mutation, or
   duplicate PR is authorized by this plan. Publication arrangement follows
   the verified dependency graph and queue state after integrated validation.

### Astra async integration repair — implementation record — 2026-09-05 — Luna Max

The generic Promise-owner handoff now uses one source-qualified fixed point.
`async-linear-planning.ts` builds an exact declaration/UnitId call closure,
including incoming awaited callers, incoming Promise carriers and outgoing
top-level async callees. `async-ir-planning.ts` retains that immutable owner
population for declaration ABI preparation and still invokes the existing
current-source proof unconditionally, so a later identity loss remains a
fatal invariant. `ir-prepared-free-functions.ts` consumes the same population
at final R3 selection while the broader source-shape population remains
available to withdraw an incomplete component before runtime attachment.

Before this repair, the settled-inner/raw-consumer matrix at B3 checkpoint
`44694026163cee6c38eea890a6df263234d93a62` prepared both `inner` and `outer`
(`direct=0`, `IR=1`) even though `run(): number` cast `outer()` to a raw C1
value; `run` remained direct and body-shape-rejected. The candidate withdraws
that component before Promise ABI publication: `inner` and `outer` are both
`direct=1`, `IR=0`, with no emitted async state and a validated, byte-identical
legacy control. The exact no-await `inner`/two-await `outer` CI shape also
compiles and validates with the same direct fallback because the no-await
callee never enters the Promise population.

The positive reversed-declaration provider control uses
`inner(): Promise<number> { return await Promise.resolve(x + 1); }`, two awaits
in `outer`, and an exact synchronous `run(): Promise<number>` carrier. Both
async owners are prepared (`direct=0`, `IR=1`), the exported call returns a
native Promise, and it resolves to `13`. The new focused closure suite is
`2/2`; the existing settled-owner, linear preparation/runtime and Promise
equivalence controls are `15/15`, `4/4`, `7/7` and `11/11` respectively.
Together the focused B2/B3 set is `39/39` after restoring the B3 proof-loss
currentness check. `pnpm run typecheck` passes. The independent host-free
`WebAssembly.validate` failure on #4106 remains outside this repair and is
recorded under the separate integration lane; no baseline was weakened.

The integration closure review found one supported existing shape that needed
an explicit carrier contract: `fetchUser()` calls stored in a typed empty
`Promise<number>[]` and consumed by the same owner's `await Promise.all`. The
closure now authenticates the vector declaration, ambient `Promise` type,
Promise-valued call, and exact lexical `Promise.all` consumer by declaration
identity; only an active fixed-point Promise owner may satisfy that edge. This
preserves the #4124/#1373b sequential, parallel, and final-main owners while
continuing to reject arbitrary typed-array pushes, casts, shadowed Promise
bindings, unknown targets, and raw C1 consumers. The focused family controls
are `4/4` after this repair, and the complete scoped async run is `61/62`:
the only red is the existing #4124 nested `pnpm exec tsx` probe blocked by the
sandbox `listen EPERM` pipe. The #3527 closure, B3, linear, #1373b, #4124,
and Promise equivalence controls all pass; typecheck remains green.

### Astra generic Promise issuance repair — implementation contract — 2026-09-05

Retain generic Promise ABI issuance independently by context and original
declaration/UnitId. At every ABI reuse and R3/await handoff, authenticate the
original declaration, reverse identity join, terminal, and exact closed
call-contract population. Missing, rebound, or contradictory evidence after
issuance is a located invariant, never raw f64, direct retry, silent cached
success, or issuance of a replacement proof. Return an actually immutable
owner collection; do not expose mutable `Set` authority. Keep preclaim refusal
distinct and preserve the provider-backed reversed-order Promise13 control.
Add all four independent post-projection mutation controls from the read-only
probe, plus source-call contract contradiction where the retained proof can
stale. Re-run the exact CI cross-call and focused B2/B3/currentness suites,
remove debug logging, and return a clean signed repair candidate.

### Astra generic Promise issuance repair — implementation record — 2026-09-05

Codex GPT-6 Astra Max continued the existing dirty B3 worktree at signed
checkpoint `44694026163cee6c38eea890a6df263234d93a62`, preserving the earlier
plans, tests, branch and claim. No replacement checkout or history rewrite
was used. The original seven-test issuance draft passed, but review found
additional gaps at the exported source-suspension gate, cached population,
caller/callee reverse joins and final allocated-slot check.

Generic ABI issuance now has a context-owned declaration lookup and a separate
original-UnitId registry. Each receipt retains the original terminal object,
source identity, source fingerprint, closed owner population, exact incoming
and outgoing call-contract fingerprint, and actual parameter/fulfillment ABI.
Every ABI reuse, source/await handoff and R3 population read starts from those
original receipts, including when the current selector has lost the owner or
supplied a different declaration. A failed receipt stays invalid after the
damaged map is restored. The final R3 slot check raises a located invariant
for a missing or contradictory already-issued Promise slot, instead of
silently declining it. The end-to-end identity and allocated-slot faults all
stop with zero direct and IR bodies for the affected owner.

The exposed owner population is a frozen read-only view over private storage.
It has no `clear`, `add` or `delete` authority; borrowing those methods from
`Set.prototype` also fails. Call-closure arrays and their records are frozen.
Incoming and outgoing source calls authenticate forward, reverse, source and
terminal joins. Asserted numeric await operands do not establish a Promise
carrier. Source parameter inference checks the same native-annotation
resolver as declaration collection, so `type i32 = number` cannot masquerade
as an f64 parameter merely because TypeScript erases the alias. Actual ABI
observations must agree with the predicted scalar/vector parameters and
numeric/void fulfillment. A contradiction before any issuance withdraws the
component; one after issuance is fatal.

The additional oracle-ratchet allowance is scoped to
`src/codegen/async-ir-planning.ts`. Its source-only preflight deliberately
reads the declaration/checker parameter and Promise-fulfillment facts and the
existing native-annotation resolver before any callable is published. These
are temporary frontend proof inputs, not fields added to the AST-free async
plan. No shared oracle baseline is changed; replacing this hybrid preflight
belongs to the separately approved whole-program preparation follow-up.

The expanded C1 controls were compared through the same public compiler API
against a read-only export of exact main
`b1537bbeca3858faf45fd89eff5506d21d1e230f`. Parent verified all 1,188 exported
source/configuration blobs; this lane retained unchanged before/after hashes
for its imported source controls. On JS-host GC, the original mixed fixture
(`base` with a settled Promise.resolve await, `twice` awaiting `base`) returns
`42` on both versions. Main IR-emits `base`; this repair withdraws both owners
before promotion because raw C1 fulfillment does not close the generic
Promise dependency. Its revised test retains the exact fixture and runtime
assertion and additionally requires one direct body, zero IR bodies and no
post-claim error for both owners. This is a change to pre-ABI component
ownership, not a claim that all C1 async semantics have migrated.

On WASI, main and candidate produce the same Node 24 validation failure at
`__promise_thenable_job`: opcode `0x1f` requires
`--experimental-wasm-exnref`. Both exact binaries validate with that feature
enabled. The C1 test now sends its unchanged compiler bytes to a narrowly
scoped Node child for validation and execution, and corrupts the magic byte
as a firing negative control. The unrelated host-free test and global Vitest
configuration are untouched. The final-async test's nested poison probe now
uses `node --import tsx` instead of the tsx CLI, retaining its positive and
negative assertions without the sandbox IPC dependency.

The exact failing CI fixture still compiles to a validated byte-identical
legacy control; its unsupported synchronous numeric cast also retains the
legacy runtime result (`NaN`). The supported reversed-declaration provider
chain prepares both async owners and returns a native Promise resolving to
`13`. Canonical no-await async behavior, wider Promise contracts and full R7
retirement remain open. Final validation results are recorded below before
the signed local candidate is handed to integration; no public push, PR
mutation, issue comment or queue action is part of this repair.

Final candidate validation uses the unchanged source after the C1 test fix.
The complete affected cohort passes **118/118 tests in 8/8 files**: generic
call closure/currentness `32/32`, settled owners `15/15`, linear preparation
`4/4`, linear runtime `7/7`, C1 async `26/26`, async plans `12/12`, final async
`11/11`, and Promise equivalence `11/11`. Typecheck passes. Both IR-only policy
lanes (single-host and standalone) pass with `5/5` expected entries, `41`
terminal units, `38` IR-emitted units, `3` non-executable units and zero
Unsupported, Invariant or legacy-body outcomes each. The six changed
TypeScript files pass Biome and Prettier; `git diff --check` and the scoped
oracle ratchet also pass. The final cohort and policy evidence is retained in
this worktree's `.tmp/astra-async-final-cohort.log` and
`.tmp/astra-async-ir-only-final.json`.
The fallback telemetry gate passes with no unintended, post-claim or
module-level increase against its committed baseline; the full issue-link
and metadata audit also exits successfully without changing any issue file.

The local signed commit runs all normal hook bodies with
`CHANGED_ROOT_TESTS_BASE=44694026163cee6c38eea890a6df263234d93a62`.
That changed-root run is repair-scoped validation, not a whole-branch result.
The full `118/118` cohort above is separate. The parent integration lane owns
the already-reviewed #4106 exnref validation fix and must pass that existing
control and the normal combined hooks on the composed candidate before any
publication is authorized.

## Isolated Astra lane B forward checkpoint (2026-09-07)

This is forward continuation from exact recoverable package-C checkpoint
`651034e4fd295e826d73a769200279210b2b35e7`, in
`/private/tmp/js2-3527-b-forward-20260907`, branch
`codex/3527-b-forward-20260907`. The lead authorized this independent tree;
it does not replace the original B branch or reclaim its assignments.
Live upstream `issue-assignments` at inspection was
`db9a738faa39f80c3554507ea9a5d927936a534c`: the original
`3518-prepared-async-frame-engine` and `3518-semantic-runtime-producers`
claims remain assigned to `ttraenkler/astra-ir-producers-b-20260905`.
The former names `codex/3518-prepared-async-frame-reconciled-20260907`;
the fork did not advertise that branch in the inspected refs. This is not
proof its work was abandoned. No duplicate extraction file was present in
the authorized checkpoint. Live PR 5692 advertised the same checkpoint.

Own changes are confined to `prepared-async-frame-engine.ts`,
`prepared-async-frame-types.ts`, the two prepared-frame tests and this handoff.
The production `ir-async-frame.ts` adapter remains unchanged while its caller
cannot supply the full preaccepted resource view. C's consumer, physical plan,
codec, replay and all runtime/provider/scheduler sources remain read-only.

### Measured base and candidate, separate denominators

On Node `v22.23.2`, the untouched base ran **24/26**: linear preparation
**4/4**, linear suspension runtime **7/7**, settled-owner runtime **13/15**.
The two failed rows are the prepared owner/caller closure and same-spelling
foreign-binding controls. They report `selection-preparation-mismatch` at
resolve: the generic Promise owner lost its source proof/ABI closure after
issuance. These are baseline failures, not candidate acceptance evidence.

The new physical-engine harness runs **10/10**, using emitted Wasm and actual
JavaScript Promises. An input-dependent two-await frame returns `24` for `7`
and `36` for `11`, with callback order `after-call`, first callback,
`after-flush`, second callback. Two same-named allocator functions with
different source-owner semantics return `12` and `21` for the same input `3`
after a late import and function-order remap. A scalar user export matching
the old resume spelling returns `77`. Each frame has nine fields, including
one captured parameter, two live spills and the result Promise; emission
returns exactly four detached function bodies and allocates no module slots.
Synchronous throws and rejected awaits reject the existing result Promise.
Missing resources, post-preflight removal, foreign owner, stale authority,
duplicate states, unsupported handlers, missing spills and wrong result
carrier fail without replacing the reserved entry body.

Fresh-process engine census runs **6/6**, including real legacy-import and
injected `ts-api` detector controls and failed instrumentation/module loading.
This proves the new engine's runtime import boundary, not the unchanged
production adapter's boundary. A direct baseline adapter import also exposed
a module-cycle initialization error in `collections-brand.ts`; it is not an
empty successful census. Neither source-free C replay nor native scheduler
execution is claimed by these host harness results.

Candidate adjacent preparation/runtime suites run **36/38**, retaining the
same two baseline failures and adding the **12/12** async-plan suite.
Async equivalence, existing native frame and host-throw controls run **17/17**
(`7 + 8 + 2`). Those unchanged production-route tests do not exercise the new
engine. The new **16/16** denominator remains distinct.

The current full typecheck passed after sealed conversion/callback roles and
the review fixes. All four outputs, including step bodies, are now built
before final currentness checks. Each callable resolution must match its
initial object/index binding, including a transient changed resolution during
step emission; the dedicated seam fails before returning output. Sparse or
duplicate parameter positions and invalid spill ranges/types fail before
operations execute. Formatting, scoped lint, IR layering/dialect/kind,
LOC/function ratchets and the harness compile-work budget pass.

The dead-export gate reports **eight** new unreachable engine functions while
production wiring is intentionally absent: `constant`, `emitPreparedFrame`,
`get`, `physicalIndex`, `preflightPreparedFrame`, `resources`, `sameType`,
and `set`, all in `prepared-async-frame-engine.ts`. No baseline was changed
and no dummy production import added. This is an explicit integration gate
failure, not a fully green production checkpoint.

### Remaining owner materialization and integration

Follow High's resource clarification through explicit caller argument
injection. `PreparedFrameResources` carries canonical binding/object handles
for frame, entry, resume, both steps and exception tag; lookup returns the
current index and identical object. The host view also supplies create,
resolve, react, callback-wrap, fulfill/reject and caught-exception functions,
plus callback IDs associated with the exact reserved step objects. Sealed
conversion roles select identities, enumerated numeric conversions or
accepted helper objects; canonical undefined requires its explicitly bound
helper. No names, provider imports, generic coercion delegates or lazy
`ensure` calls are consulted by the engine.

The native view requires Promise and reaction-node type objects, fulfill,
reject and enqueue functions, and an explicit mark-handled/not-required
policy. C/provider ownership must supply the fixed-point scheduler/global
closure, canonical value boundaries, exact function/type/tag contracts and
authenticated session/plan/runtime currentness. This checkpoint includes the
native instruction branch reusing `prepared-native-async-await.ts`, but its
runtime validation and production materialization remain open.

C must validate requirements before acceptance, bind the complete resource
view before lowering, pass it explicitly into the prepared adapter, install
the four returned bodies, and reconcile observations. The adapter must then
lower actual validated IR through these operations and remove its old live
engine/provider imports. C's existing located async materialization refusal
remains unchanged. Post-acceptance missing handles are fatal, never a retry
through the old engine. Until that composition and its import census run,
this is an **unconnected physical-engine checkpoint**, not completed lane B
or full direct-codegen retirement. Any PR retaining this base depends on
PR 5692 and must identify that stack dependency.

## Astra High lane B — prepared frame engine without AST reachability (2026-09-07)

Continue `ttraenkler/astra-ir-producers-b-20260905`'s held
`prepared-async-frame-engine` scope, branch
`codex/3518-prepared-async-frame-reconciled-20260907`; liveness and latest
commits must be recovered by the lead. Implementation model: **Astra Low**.
The [epic continuation specification](3518-ir-only-default-and-direct-frontend-retirement.md)
records all peer claims and package C's exclusive files. This plan is not a
replacement dispatch and does not authorize rewriting C's consumer.

### Why the current prepared input does not retire the direct graph

At upstream `b3133d1d4da1151d82ef45b58db9566565097c57`,
`src/codegen/ir-async-frame.ts` imports
`emitPreparedAsyncFrameStateMachine` from `src/codegen/async-frame.ts`.
`lowerPreparedIrAsyncFunction` verifies current runtime identity, builds a
frame layout and passes a callback CFG to that shared engine. The wrapper
calls `emitAsyncFrameEntry(..., null, cfg)`; the shared engine still imports
AST expression/statement dispatch and the checker-backed CPS machinery.
`AsyncCfgOperand` in `async-cps.ts` accepts either a `ts.Expression` or an
emit callback. The runtime path's type surface therefore permits AST fallback,
and its transitive import graph retains the direct walkers even when one
particular function supplies only callbacks.

`buildFrameInfo` also allocates types immediately, and the shared entry code
recovers a resume index from `ctx.funcMap` by a sanitized function name. The
next slice must separate pure physical requirements from allocation and
preserve exact allocated object identity across index changes. Copying the
AST-bearing union into a differently named file does not achieve this.

### Ownership, design and invariants

Write only `src/codegen/ir-async-frame.ts`, new/recovered
`src/codegen/prepared-async-frame-engine.ts`, new
`src/codegen/prepared-async-frame-types.ts`,
`tests/issue-3527-prepared-frame-import-boundary.test.ts`, and
`tests/issue-3527-prepared-frame-runtime.test.ts`. Reuse already implemented
B extraction modules if recovery finds them. Treat `async-frame.ts`,
`async-cps.ts`, A's program contracts, C's consumer/physical plan and the
separate runtime host-adapter owner as read-only. If a required shared API is
absent, report the exact contract change to its owner rather than silently
widening this lock.

1. Define prepared-only local emission types. State leads are emission
   operations derived from validated IR, terminators reference typed value
   IDs or local emission operations, and handler/finalizer state comes from
   the semantic plan. No `ts.Node`, checker, AST-or-emit union, source text or
   parser callback belongs to these types. Process-local emission callbacks
   are permitted only **after** backend acceptance; they are never serialized
   as part of `PreparedIrProgram` or its runtime projection.
2. Move only the prepared entry/resume algorithm into the new engine. Consume
   a complete preaccepted frame layout, spill mapping, Promise carrier,
   callback adapters, type/function/global handles and exception contract.
   Preflight proves all required resources and supported state/handler shapes
   before allocation. Unknown materialization remains C's located Unsupported;
   malformed plans are invariants. No lazy `ensure*` discovery in accepted
   emission, and no emitter-internal frontend selection.
3. Replace the import from `async-frame.ts` and the dependency on
   `AsyncCfgPlan` from `async-cps.ts` in `ir-async-frame.ts`. Reuse physical
   helpers only when their runtime import closure excludes AST/checker/direct
   dispatch. Type-only imports are erased and should be distinguished by the
   boundary test. Avoid the broad `shared.ts` barrel when it pulls legacy
   dispatchers; name the actual primitive module for required coercion/locals.
4. Bind entry/resume/callback references by existing symbolic binding IDs and
   allocator objects, never `fn.name`, sanitized stems or suffix search.
   Resolve the current physical index from that handle. Preserve import
   shifting, DCE remapping and recurrence group rules; failing handle
   resolution cannot fall back to a saved number or name lookup.
5. Preserve the existing semantic graph and state order. Entry runs once to
   the first suspension; continuation resumes the planned state; live values
   survive repeated awaits; fulfillment/rejection/throw keep Promise identity
   and microtask behavior. This extraction does not widen supported handlers:
   upstream `preparedCfg` rejects nonempty handlers, so adding full finally
   support requires separately validated lowering and is not an incidental
   part of moving the engine.
6. C adopts the new physical engine through its own acceptance/materialization
   implementation after B supplies requirements and tests. B demonstrates a
   real lowerer/runtime positive control; it does not patch C to make a missing
   runtime provider appear available. Leave legacy AST engine deletion for the
   final whole-program reachability cut, after all users have migrated.

### Acceptance with load-bearing controls

- Fresh-process runtime import census for the prepared engine and its actual
  entry adapter must contain no `typescript`, `ts-api`, checker,
  `codegen/expressions`, `codegen/statements`, `async-cps`, or `async-frame`
  runtime module. Use actual loaded modules, not only an import-text grep.
  Inject a forbidden import in a temporary fixture and prove the census fails;
  absence of events/unsupported instrumentation fails rather than returning
  an empty successful census.
- Execute an input-dependent async function with two numeric awaits and a live
  value carried across both; assert exact result, stable returned Promise and
  callback/microtask ordering against JavaScript. Exercise host and supported
  standalone native Promise runtime. C's linear runtime refusal is recorded
  as a dependency until its owner supplies physical support.
- Two same-named async functions in different sources must have distinct
  frames/resume targets. Add a user export matching the old sanitized resume
  name. Both results remain correct. Inject a late import/remap through an
  approved allocator test seam and assert handle resolution selects the same
  object; an unbound handle is fatal, never name-resolved.
- A stale plan/current-runtime pair, foreign-owner projection, missing spill,
  missing callback capability, unsupported handler, duplicate state, and wrong
  Promise result carrier each fail before emission with the appropriate
  invariant or supported capability classification. After acceptance, remove
  a bound resource via a test seam: emission fails without publishing output
  or retrying through AST. Keep a passing scalar control in the same harness.
- Poison legacy AST body entry on a previously supported prepared async
  fixture; prepared execution passes. Restore only the legacy-engine import
  in an isolated removal control and require the module-boundary test to fail.
  The original body must remain input-dependent so constant folding cannot
  erase the evidence.

Run the existing prepared async/currentness/frame suites identified in the
recovered B branch, the two new tests, async equivalence, typecheck, IR
layering/dialect/kind checks and resource/LOC/function ratchets. Compare base
and candidate outputs on the same runtime configuration. Record final
functions/imports/frame fields, executed values, phase and failure rows.
Do not describe an AST-free parameter type or a mocked engine as completed
AST-free backend emission.

**Astra Low lane B prompt:** Resume the existing prepared-frame extraction
with the exact ownership above, after the lead confirms its recovered head.
You are not alone in the repository; preserve other edits, including C and the
host-provider owner. Reproduce the actual prepared-to-legacy import path,
then remove it by a prepared-only physical engine with no semantic AST
fallback. Validate loaded-module census, two-await runtime behavior,
source-qualified resume identity, tamper failures and the import removal
control. Return the exact requirements C must materialize, without changing
C's implementation or claiming its async acceptance has passed.
