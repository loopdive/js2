---
id: 3523
title: "IR-only R4: typed ordered module-init compile-once ownership"
status: in-progress
sprint: current
created: 2026-07-21
updated: 2026-09-02
priority: critical
horizon: xl
complexity: XL
feasibility: hard
reasoning_effort: max
task_type: refactor
area: ir, codegen, modules
language_feature: compiler-internals
es_edition: multi
goal: ir-full-coverage
lane: ir-retirement-r4
model: gpt-5.6-sol
parent: 3518
depends_on: [3521, 3522]
required_by: [3525]
related: [1789, 2796, 2931, 2965, 2992, 3142, 3517, 3518, 3783, 4273, 4275]
origin: "#3518 R4 — replace compile-first/patch-later __module_init with typed ordered prepare-before-emit ownership"
files:
  - src/ir/module-init.ts
  - src/ir/module-init-plan.ts
  - src/ir/program.ts
  - src/ir/prepare.ts
  - src/ir/from-ast.ts
  - src/ir/select.ts
  - src/ir/integration.ts
  - src/ir/array-element-lowering.ts
  - src/ir/passes/batch-string-concat.ts
  - src/codegen/declarations.ts
  - src/codegen/declarations/module-init-pass2-stable.ts
  - src/codegen/index.ts
  - src/codegen/ir-prepared-free-functions.ts
  - src/codegen/context/types.ts
  - tests/issue-3523-ir-module-init-compile-once.test.ts
  - tests/issue-3523-module-init-single-pass.test.ts
  - tests/issue-3523-ir-calendar-retirement.test.ts
  - tests/issue-2766.test.ts
  - tests/issue-2856-nonterminating-if-guard.test.ts
  - tests/issue-3734-i32-array-elements.test.ts
  - tests/issue-4110-ir-fetch-all-parallel.test.ts
  - tests/ir/passes.test.ts
loc-budget-allow:
  # 2026-09-01 (gap 2b, scalar-statement overlay remainder): +80 lines in
  # `src/codegen/index.ts`. The slice's whole contract is that both edits stay
  # inside that file — the widened admission predicate
  # (`preparedScalarModuleStatementShape` plus the two operator allowlists) and
  # the retirement of the `sawAssignment` ordering refusal. The predicate is the
  # gate of the prepared module-init transaction; moving it to a subsystem
  # module would split the ownership the transaction exists to hold, and the
  # measured payoff is byte-neutrality on every already-admitted shape (V-A,
  # 15/15 `cmp`-identical) with no IR-fallback bucket movement (V-D).
  - src/codegen/index.ts
  # 2026-09-01 (gap 3, WASI prepared module-init adapter): the guard stops being
  # a post-emission splice and becomes invocation-policy-driven, which grows two
  # more prepared-route owners. `multi-prepared-program.ts` gains invariant 7's
  # third arm (`wasi-start-export`) in `finalizePreparedModuleInitStartup` so an
  # M2 WASI admission cannot land the zero-reconciliation hole this slice closed
  # on the single-module route; `ir-prepared-free-functions.ts` gains the one
  # option that tells the prepared preparation call — and only it, never the
  # post-direct overlay — to construct the body around the reserved
  # `__init_done` guard. Both are reconciliation/routing at the site that owns
  # the prepared module-init transaction; there is no subsystem module to move
  # them to without splitting that ownership.
  - src/codegen/multi-prepared-program.ts
  - src/codegen/ir-prepared-free-functions.ts
  - src/codegen/index.ts
  - src/codegen/declarations.ts
  - src/codegen/closure-exports.ts
  - src/codegen/context/types.ts
  - src/ir/builder.ts
  - src/ir/from-ast.ts
  - src/ir/integration.ts
  - src/ir/lower.ts
  - src/ir/nodes.ts
  - src/ir/prepared-component-dependencies.ts
  - src/runtime.ts
  # 2026-09-01 (gap 1b, skip pass 2 for closure-free call-bearing inits): +11
  # lines in `src/codegen/declarations.ts`, all of them the comment the slice
  # was asked to correct. The historical text claimed pass 2 exists "so call
  # sites inside module-level code can see the final inlinable-function
  # registry"; measured (`JS2WASM_IR_INLINE=0`) the two-pass `__module_init`
  # still emits a plain `call` for a module-level call, and the registry reaches
  # only closure BODIES compiled during init. Leaving the old sentence in place
  # would leave the next reader with the reason the gate is NOT built on. The
  # executable change at the gate itself is one identifier.
  - src/codegen/declarations.ts
  # 2026-09-02 (gap 6a v2, module-scope closure pre-lift + discovery-static
  # pass-1 skip, OPT-IN): +51 lines in `src/codegen/declarations.ts`. The slice's
  # own logic all lives in the NEW subsystem module
  # `declarations/module-init-closure-prelift.ts` (~460 lines); what lands in
  # `declarations.ts` is the wiring that cannot live anywhere else — the pass-1
  # condition, the pre-lift branch that replaces it under the seam, the pass-2
  # disjunct, and the comment recording why
  # `JS2WASM_TEST_FORCE_MODULE_INIT_PASS2` restores BOTH passes (it is the A/B
  # baseline every pin in this family compares against).
  # `compileDeclarations` is the only function that owns the two-pass sequence,
  # so a slice that can remove one of the passes has to edit it. +2 lines over
  # the first landing's grant: the opt-in seam read and the guard that keeps the
  # (#4195) dedupe mark in its historic position on the default route — both of
  # them exist BECAUSE the default flipped off, see the gap-6a v2 repair record.
  - src/codegen/declarations.ts
func-budget-allow:
  # 2026-09-01 (gap 1b): the same +11 comment lines land inside
  # `compileDeclarations`, which is where the pass-2 gate lives; the gate cannot
  # be documented anywhere else.
  - src/codegen/closure-exports.ts::emitClosureMethodCallExportN
  - src/codegen/index.ts::planIrOverlay
  - src/codegen/index.ts::generateModule
  - src/codegen/declarations.ts::compileDeclarations
  - src/ir/from-ast.ts::lowerFunctionAstToIr
  - src/ir/from-ast.ts::lowerMethodCall
  - src/ir/integration.ts::compileIrPathFunctions
  - src/ir/integration.ts::makeResolver
  - src/ir/lower.ts::emitInstrTree
  - src/ir/lower.ts::lowerIrFunctionBody
  - src/ir/prepared-component-dependencies.ts::collectFunctionEvidence
  - src/runtime.ts::resolveImport
---

# #3523 — IR-only R4: typed ordered module-init compile-once ownership

## Objective

Make top-level evaluation a typed, ordered unit of `PreparedIrProgram` before
any body emitter runs. A non-empty single-source program receives exactly one
terminal module-init outcome:

- **Prepared** — lower and emit one IR-owned `__module_init` body;
- **Unsupported** — under the temporary hybrid policy, compile one direct body;
- **Invariant** — fail before publication; never retain or patch another body.

Replace the current filter-a-statement-list, compile direct twice, then patch by
the string `__module_init` model. Preserve observable source order, TDZ and live
binding behavior, class static evaluation, host/deferred/WASI startup policy,
and exactly-once side effects. R4 is complete only when a Prepared module-init
has `direct=0, IR=1` and an Unsupported module-init has `direct=1, IR=0`.

## Standalone continuation (#4566, 2026-08-20)

The pre-#4566 standalone census was 22 IR-emitted terminals, 18 legacy bodies,
15 typed Unsupported terminals, and zero Invariants. The only legacy bodies
not paired with an Unsupported outcome were Algorithms `<module-init>`,
`fibMemo`, and `main`. #4566 owns the bounded continuation that admits exact
single-binding lexical initializers under standalone's native-string
Wasm-start and deferred-export policies, then seals their storage readers and
callers in the same component. The checkpoint is 15 legacy bodies with the
IR/Unsupported counts unchanged. Deferred exports retain TDZ checks until the
host calls `__module_init`; only Wasm-start may elide them. Async, DOM, native
Date, WASI, and non-exact module-init shapes stay outside this slice.

The completed checkpoint also preserves optimization parity: final standalone
Algorithms IR is 9.1% faster than direct on the bounded workload, 2.9% faster
on a fresh first call, and on par on a fresh second call. It is 1.26% smaller
raw and gives `fibMemo` the direct path's exact lookup/hash/no-box call shape;
see #4566's checkpoint result for the controlled A/B and artifact inventory.

## Current evidence

The existing module-init claim is an overlay over a legacy ABI and body:

- `src/ir/module-init.ts:8-27` only filters a `SourceFile` into a flat statement
  population. It excludes class declarations and therefore cannot represent
  their ordered static field/block effects. At `:30-40` it wraps that population
  in a synthetic function named `<module-init>`.
- `src/codegen/declarations.ts:2076-2105` mutates TDZ analysis state and
  allocates `__tdz_*` globals before module-init compilation.
- `src/codegen/declarations.ts:2108-2117` derives three side channels — module
  statements, reassigned-function live seeds, and class static initializers —
  rather than one ordered program plan.
- `src/codegen/declarations.ts:2119-2148` snapshots four order-sensitive maps
  solely because the body is compiled twice. `compileModuleInitBody` at
  `:2150-2229` emits all live seeds, then all static initializers/blocks, then
  all module statements through direct `compileExpression` / `compileStatement`.
- The first direct compile occurs at `src/codegen/declarations.ts:2232-2237`;
  the second occurs at `:2351-2360` after top-level functions populate the
  inlining registry. Both mutate compiler state even though only the later body
  is shipped.
- `src/codegen/declarations.ts:2366-2441` allocates `__module_init`, exports it
  for `deferTopLevelInit`, or wires it to the Wasm start section. Multi-source
  compilation currently replaces earlier same-name exports at `:2420-2430`.
- `src/ir/integration.ts:498-580` refuses static initializers and live-function
  seeds, requires legacy-allocated numeric/boolean globals, and builds IR only
  after the direct slot exists. Build failure demotes back to that body.
- `src/ir/integration.ts:921-970` finds `__module_init` by flat display name,
  checks its legacy-created type index, and patches the existing function.
- `src/codegen/index.ts:3750-3863` subsequently mutates the body for the
  in-module flag and WASI idempotency guard. At `:3865-4043`, `_start` selection
  and reactor/error tails locate `main`/`__module_init` by name and decide when
  initialization runs.

#3142 made a narrow initializer population claimable. #3517 removes the last
measured Algorithms initializer residual. Neither proves compile-once
ownership, includes the omitted side channels, or makes the legacy slot dead.

### 2026-08-09 Test262 scoring dependency

#4275 supplies a direct pass-rate witness for this structural boundary. Its 15
resolved-target ES2015 `for-of` assignment-destructuring fixtures all place the
target loop in the literal harness's source-owned `<module-init>` terminal. A
production outcome report for `array-elem-iter-nrml-close.js` rejects that
terminal at `vardecl-var-kind:FirstStatement`, emits the legacy init body, and
emits no IR body. The loop cannot be selected as a smaller function terminal.

Consequently a prepared iterator instruction and green function-local probe do
not move those Test262 rows. R4 must consume #3783's genuine module-global
`var`/hoisting representation and emit the complete ordered terminal once;
wrapping the test body alone or shadowing its script globals would be false IR
ownership. This is an exact conformance dependency, not a request to add
Test262-shaped routing to R4.

## Typed `ModuleInitPlan` contract

R4 adds one source-qualified `ModuleInitPlan` to the R2 `PreparedIrProgram`.
The plan is built from source positions plus R1 identities/ABI slots; it is not
reconstructed from mutable codegen queues. It records, in semantic order:

1. **Instantiation/prelude intents** — function live-binding seeds and other
   hoisted binding state that must exist before user evaluation.
2. **Binding storage and TDZ intents** — `IrBindingId`, planned global/local
   storage, initialization state, mutability, and source-located TDZ actions.
3. **Ordered evaluation entries** — variable initializers, executable
   statements, class evaluation, static fields, and static blocks, each with a
   source ordinal and the owning `IrUnitId` / `IrClassId`.
4. **Export/live-alias intents** — the canonical binding/slot an export or
   reassigned function observes; aliases do not create a second initializer.
5. **Invocation policy** — ordinary host Wasm start, deferred host export,
   standalone, or WASI `_start`/export guard, including exactly-once rules.

The plan must explicitly represent an empty/non-executable module. An empty
plan is accounted for without emitting a bogus function. No entry may be
silently dropped because it has no direct-codegen queue representation.

## Ordering and ownership invariants

1. Build TDZ/storage, function/class ABI, closure captures, static intents, and
   invocation policy before either backend emits a body. All indices come from
   `ProgramAbiMap`; no lookup of `__module_init` or a source binding by name may
   allocate or discover ABI during lowering.
2. Preserve JavaScript evaluation order across interleaved statements and
   class declarations. Static fields/blocks run at their class evaluation
   position, not as an unordered queue before every top-level statement.
3. Prelude live-function seeds occur before the first observable top-level
   read, once per canonical binding/global. Reassignments update the same
   planned binding and export aliases observe it live.
4. TDZ flags/storage exist before evaluation, and each successful declaration
   transitions its binding once. An early read throws; a later read observes
   the initialized value. A failed initializer cannot look initialized.
5. A Prepared plan is sealed before emission. Any later missing binding, ABI
   slot, static entry, runtime intent, lifted function, or backend legality
   failure is an Invariant and cannot demote to the direct body.
6. An Unsupported plan is decided before emission and compiles direct exactly
   once. R2/R3's complete unit inventory replaces the first pass's closure and
   inlining discovery purpose; restoring two direct passes is forbidden.
7. Startup wiring consumes a planned init slot. Ordinary host start,
   `deferTopLevelInit`, standalone, and WASI may choose different invocation
   adapters, but no configuration may invoke the semantic body twice or omit
   it when an exported entry is called first.
8. Source-unit counters and backend-emission counters reconcile separately.
   Support wrappers, start guards, and `_start` are named support units; they do
   not inflate the one module-init source-unit denominator.

## Bounded landing sequence

### Commit 1 — ordered plan and parity inventory, no routing change

- Define `ModuleInitPlan`, entry kinds, invocation policy, and verifier.
- Build the plan beside existing queues and compare its order, bindings,
  statics, TDZ actions, live seeds, exports, and invocation mode in telemetry.
- Add failure injection for missing/duplicate/reordered entries and prove
  inventory equals one terminal outcome before touching body routing.

### Ordered-plan foundation (2026-08-02)

The first Commit 1 seam now builds an immutable, source-qualified
`IrModuleInitPlan` directly from the exact source and R1 identity inventory
before any function body emitter runs. It records top-level binding storage and
TDZ identities, reassigned-function live seeds, source-ordered statement and
class-static evaluation entries, export aliases, and the host/deferred/WASI
exactly-once invocation policy. Empty/function-only modules receive an explicit
non-executable plan instead of a synthetic initializer.

This landing deliberately does not change routing. Production single-source
compilation compares the semantic plan with the existing live-seed,
`staticInitExprs`, and `moduleInitStatements` queues and publishes the complete
parity record. The anti-vacuity fixture proves the record catches the current
all-statics-before-statements reorder while distinguishing it from missing or
extra entries. Destructuring bindings and executable top-level semantics with
no inventory-owned module-init unit remain explicit typed plan gaps; neither is
silently dropped.

Focused validation is **6/6 passing**, and TypeScript validation passes. The
seven-file adjacent matrix is **51/55 passing**: both #3142 failures reproduce
unchanged on an untouched `origin/main` control, while the other two tests
require the optional `test262-fyi/data` submodule that is absent in this
worktree. Fallback, hybrid-readiness, optimization-retirement, issue, lint,
format, LOC, and function-budget gates pass. R4 routing remains blocked on the
remaining R3 class ownership and on consuming these plan entries through the
prepared emission transaction. The next R4 slice should replace the legacy
static/module queue partition with this ordered entry stream for a
capability-complete scalar module, then prove `direct=0, IR=1` without changing
startup behavior.

#### Merge-queue multiplicity correction (2026-08-02)

The first merge-group run exposed a valid class-expression population whose
direct backend registers each static initializer once per internal class
owner. Six source initializer ranges therefore appeared twice in the legacy
queue. The read-only parity probe collapsed identities to source ranges and
treated that multiplicity as a malformed semantic plan, turning 142 candidate
Test262 rows into the same compile error before body emission.

Reconciliation now keeps the semantic plan's unique-entry invariant while
pairing each observed queue key with an occurrence ordinal. Repeated legacy
entries remain visible as `extraInLegacy`; they make parity non-aligned but no
longer make valid source fail compilation. This preserves the evidence R4
needs to eliminate the duplicate direct work later without allowing the
observer itself to change production behavior.

Focused coverage is **8/8 passing**. The exact previously failing generated
class-expression source now compiles successfully, validates as Wasm, and the
minimal two-private-static fixture records four legacy observations over two
source ranges instead of throwing. The fixed head must still complete a fresh
merge-group Test262 run before landing. The expanded seven-file adjacent
matrix is **53/57 passing**: the same two #3142 failures reproduce on pristine
current `main`, and the remaining two rows require the absent optional
`test262-fyi/data` submodule.

### Builtins checkpoint and remaining-body handover (2026-08-09)

The Builtins externref-ABI checkpoint leaves every one of the 37 targeted
terminal units with an IR body, but 16 of those units still retain a legacy
body. This is a measured census, not R4 completion. The exact remaining
population is:

- **Algorithms — 6 bodies:** module init, `fibMemo`, `binarySearch`,
  `quicksort`, `joinNums`, and `main`.
- **Calendar — 10 bodies:** module init, `el`, `mname`, `dimOf`, `fdow`,
  `priceOf`, `renderCal`, `onDay`, `updFoot`, and `main`.

Retire that population in two atomic production PRs, in this order:

1. **Algorithms, 16 → 10.** Move its module init and five functions through
   one prepared Program-ABI transaction. Preserve the ordered, exactly-once
   `Map` initialization and persistence across calls; recursive `fibMemo`;
   vector use; in-place quicksort mutation; the proven-i32 midpoint without
   boxing; number formatting and string append behavior; and the exact
   20-line observable trace. Parity tests must prove all six units emit through
   IR with no legacy body, fallback, duplicate init, or optimization loss.
2. **Calendar, 10 → 0.** Move its module init and nine functions through the
   same ownership model. Preserve source-ordered global initialization, exact
   `Date` imports, all seven lifted callbacks, and preparation of nested
   executable syntax. Parity tests must prove all ten units emit through IR
   with no legacy body or fallback and retain current rendered/runtime
   behavior.

Both PRs must pass hybrid accounting and IR-only shadow validation, and each
must reduce the checked legacy-body ceiling by its exact family count. Delete
an obsolete legacy implementation in the same PR only after the replacement's
tests and consumer inventory prove it has no remaining callers.

Keep exactly one overlapping production PR active: finish and land Algorithms
before opening Calendar. Parallel work is limited to disjoint tests,
inventories, optimization audits, and reviews. This Markdown issue and the
parent/adjacent `plan/issues` records are the ownership and handover source of
truth; do not create or use GitHub Issues for this migration checklist.

### Algorithms compile-once checkpoint (2026-08-09)

The Algorithms transaction now retires the exact six-body population above.
All six functions plus the source-qualified `<module-init>` terminal seal as
one dependency-complete prepared component, and all seven record
`legacyBodyEmitted: false`, `irBodyEmitted: true`. The checked hybrid census is
now **5/5 entries, 37/37 IR-emitted terminals, 10 legacy bodies, 0 Unsupported,
and 0 Invariant**, reducing the ceiling from **16 to 10**. Strict IR-only is
expected-red for one reason only: the ten Calendar bodies listed below.

This is a deliberately bounded first R4 owner. Production routing accepts only
the host WasmGC shape `const <binding> = new Map<K, V>()` with zero constructor
arguments after the typed selector, complete/gap-free semantic init plan,
legacy-plan parity, and ordinary Wasm-start policy all agree. The compiler
preallocates the source-qualified Program ABI init callable before IR
preparation. A complete component fills and preserves that exact slot through
IR; a rejected or failed preparation fills the same slot once through the
existing direct route. Standalone, WASI, deferred, native-string, fast,
multi-statement, mutable-binding, and other initializer shapes remain
fail-closed on the established route.

The acceptance oracle proves:

- the exact 20-line playground trace on two calls, one `Map_new` during
  instantiation, one persistent receiver, and no second-run memo writes;
- active direct-function and direct-module-init poison seams, with all five new
  function bodies and the initializer bypassing them while unsupported controls
  still reach them;
- the original numeric/vector call shapes: call-free `binarySearch` with an
  `i32.shr_s` midpoint, exact recursive `fibMemo`, four typed quicksort vector
  stores with one tail call, and scalar `joinNums` formatting; and
- the direct backend's synchronous concat batching through the target-neutral
  `batchStringConcat` IR pass: one `__concat_6`, three `__concat_3`, no
  accidental `__concat_4`, four required pairwise calls, stable leaf order,
  and conservative shared-intermediate/two-part near misses. Builtins parity
  independently pins the same direct/IR batching shape.

The dependency preparation fixes are general rather than Algorithms-name
special cases: concrete i32/f64 JS bitwise operands no longer invent a dynamic
unbox dependency, exception support is discovered through all nested final-IR
buffers before sealing, and callable-import planning no longer seals at string
length attachment before late semantic providers are registered. The new
`IR-OPT-SYNC-BATCHED-CONCAT` ledger row makes this migrated optimization
explicit and fail-closed.

Pre-publication qualification is green for the 68-test Algorithms, Builtins,
pass, and prepared-dependency matrix; TypeScript, lint, formatting, fallback,
hybrid readiness, allocation provenance, equivalence, vacuity shape, oracle,
LOC/function budget, issue-integrity, and optimization-retirement gates. The
full equivalence gate reports no new regressions and 12 existing baseline rows
now passing; this PR does not rewrite that shared baseline. The wider adjacent
matrix passes 102/106: the same two #3142 failures reproduce on the untouched
base commit, and two #3505 cases require the optional uninitialized
`test262-fyi/data` submodule. Full Test262 remains merge-queue-only.

No shared legacy implementation is deleted in this checkpoint. The ordinary
function-body and module-init emitters still have the ten measured Calendar
consumers plus broader unsupported hybrid shapes, so deleting either would
remove live behavior. The next and only overlapping production family is:

- Calendar module initializer, `el`, `mname`, `dimOf`, `fdow`, `priceOf`,
  `renderCal`, `onDay`, `updFoot`, and `main` (**10 → 0**).

Resume from branch `codex/3523-algorithms-retirement` in isolated worktree
`/private/tmp/ts2wasm-3523-algorithms-retirement`; the dirty root checkout is
outside it and must remain untouched. Publish one ready PR, freeze it once
queued, and run full Test262 only through the merge queue. Do not start the
Calendar production branch until this checkpoint lands or is explicitly
withdrawn.

### Calendar retirement oracle and resumable handover (2026-08-09)

The final family in the five-entry single-host playground lane has a disjoint test-only checkpoint on branch
`codex/3523-calendar-test-oracle`:

- `c3384c7748302ecfcff65f8bbc16176e711a7349` adds the deterministic runtime,
  DOM, `Date`, callback, and direct-codegen optimization reference;
- `7eef50559a2bcaaf54df50138b8eec68c389bf01` hardens the disabled production
  contract around the exact ten-row IR-only outcome, seventeen emitted
  artifacts, nine function skips, callback retirement, numeric Program-ABI
  global access, relative body/binary ceilings, and mutation-free collision
  fallback.

The original active portion passed **4/4** and the **7** final retirement tests remain
intentionally skipped until production satisfies them. The oracle exercises
twelve renders; December/January navigation; hover and selection isolation;
the exact `2300`/`2800`/`2550 EUR` totals; clear/save behavior; fourteen ordered
`Date` snapshots; 1,120 callback registrations; and the seven exact statically
lifted callback owners. The final gates reject every legacy `__cb_N` body and
require the direct fallback artifact to remain byte/import/runtime-identical
after a preflight collision.

The Calendar 10 → 0 implementation is ready once the Algorithms PR lands. It
is a prepared-transaction problem, not a request for new IR instruction
lowering:

1. Generalize the exact-`Map` module-init selector into a capability-based
   ordinary-host lexical-initializer selector. Require exact source/module
   identity, Wasm-start/exactly-once invocation, one-to-one plan
   binding/evaluation order, and exact global/TDZ Program-ABI IDs. Keep
   `var`, destructuring, missing/multiple initializers, executable/class
   statements, deferred startup, and incompatible modes fail-closed.
2. Extend only the R2 prepared-free-function selector to admit arrows named by
   `plan.hostVoidCallbacks`, with exact owner and contiguous ordinal. Walk the
   admitted callback bodies and reject every unplanned nested function/class;
   do not relax the stricter class/Promise nested-executable rule.
3. Before any TDZ/global/import/callable mutation, preflight the callback maker,
   every required `Date` import, and exact uncontested typed-DOM providers. Any
   loss rejects all ten terminals with one typed unsupported reason and zero
   prepared skips. The `Document_createElement` collision is a known-red
   contract until this provider check exists.
4. After `prepareIrBodies`, require exactly ten patched terminal owners, one
   non-empty component, seventeen artifacts with correct owners, no errors or
   deferred/preserved bodies, and the exact nine function plus one module-init
   skip projection. A mismatch after successful preflight is an invariant and
   must abort compilation; partial direct fallback is forbidden.

Optimization parity is part of the transaction, not follow-up cleanup:

- elide module-binding TDZ guards only for exact post-Wasm-start function
  owners proven non-escaping; module init, class bodies, deferred/standalone/
  WASI paths, unknown escapes, and stale evidence retain guards;
- lower a constant nonterminating `if` without `else` directly into its body
  without lowering/evaluating the condition twice;
- use the IR's native `i32` vector length in the two safe Calendar reads,
  preserving unsigned bounds checks and array reads while removing the
  `f64` conversion/truncation pairs;
- coalesce adjacent literal concat leaves only with single-use/provenance
  proof, canonical deep nested-buffer string preparation, and refreshed
  allocation/encoding metadata. The required Calendar shape is
  `__concat_8: 1 → 0`, `__concat_7: 0 → 1` with unchanged leaf order.

Current landing and handover sequence:

1. The isolated Calendar production worktree, checkpoint recovery, generic
   transaction, optimization parity work, and checked legacy-body reduction
   **10 → 0** are complete.
2. Open one ready PR from `codex/3523-calendar-retirement`, run the full CI and
   merge-queue gates, and freeze the exact head once queued.
3. After landing, continue the repository-wide retirement families tracked by
   #3518: broader classes/methods, closures/cross-owner calls, generic module
   initialization, and runtime/linear-memory helpers. Do not reopen the bounded
   Calendar implementation unless a regression gate fails.

#### Calendar playground final parity checkpoint (2026-08-12)

The live production branch is `codex/3523-calendar-retirement` in isolated
worktree `/private/tmp/ts2wasm-3523-calendar-retirement`, rebased onto
`origin/main` `81ff7c4b1daa83`. The dirty root checkout
remains untouched.

The bounded Calendar transaction is now implemented and focused-green:

- all **10/10** terminals seal in one prepared component;
- all **9** source functions and the source-qualified module initializer emit
  through IR with `legacyBodyEmitted: false`;
- the seven exact callback plans produce seven owner-qualified derived
  closures and no legacy `__cb_N` artifacts;
- the bounded playground shadow is **5/5 entries, 37/37 targeted terminals,
  zero legacy bodies, zero Unsupported, and zero Invariant**;
- the independent twelve-render DOM/Date oracle, 1,120 callback registrations,
  direct-body poison controls, and real plus injected import-collision controls
  pass; and
- focused Calendar acceptance is **14/14**; the complete changed-root hook is
  **194/194** across the eleven affected suites after the final rebase.

The production selector remains intentionally bounded. It accepts only a
gap-free sequence of initialized top-level `let`/`const` declarations with
exact source, binding, TDZ, evaluation-order, and ordinary Wasm-start parity.
It rejects destructuring, `var`, missing/multiple initializers, deferred and
host-free modes, Promise/source-import preparation, and any initializer that
can execute a same-source function or class before lexical initialization.
The exact post-start TDZ certificate is projected only to selected function
UnitIds and exact binding IDs; the module initializer and rejected/unselected
owners retain their checks.

Preparation is atomic before mutation. The component proves the current env
function-import occupants, callback-maker ABI, and every required Date import
before allocating TDZ globals or publishing Program ABI state. A collision
withdraws all ten terminals with one typed `late-preparation-unsupported`
reason and leaves an import- and byte-identical direct artifact. Tests cover
both untouched-source injected failures and real source declarations that
occupy `__make_callback` or `Document_createElement`.

Optimization and artifact evidence is explicit:

- the direct build is byte-identical to `origin/main` (SHA-256
  `53895828283af9a34d20c21353dd1a858a195447de351e901b9985accb31b911`)
  at **12,895 raw / 4,795 gzip / 74,663 WAT / 28 defined functions**;
- current all-IR (SHA-256
  `9e31fb9fba6bc7840f8284fb562596f90ead95f21e3b4ae4f5a3dcbf53ae92c6`)
  is **12,493 raw / 4,742 gzip / 70,034 WAT / 31 defined functions**;
- against direct, IR is now **3.12% smaller raw, 1.11% smaller gzip, and
  6.20% smaller in WAT**, with only three additional defined functions. The
  acceptance test rejects any future raw/gzip/WAT growth above the direct
  artifact rather than preserving the former positive gap;
- deterministic repeat builds, raw/gzip/WAT/function/import ceilings, and the
  exact direct arithmetic, bounds, concat, formatting, DOM, Date, and TDZ
  helper shapes are enforced in the acceptance test; and
- `renderCal` is **71 locals / 14,998 WAT bytes** versus direct's
  **63 / 19,112**; `main` is **24 / 5,776** versus **35 / 6,962**; and the
  aggregate Calendar bodies are **133 / 39,909** versus **142 / 46,750**.
  Generic nested-region stackification also preserves the pre-existing i32
  vector read shape and removes the `fetchAllParallel` Promise-result spill.
  The fail-closed ceilings are now **72 / 135** locals for `renderCal` /
  aggregate, with all three body-size comparisons bounded at direct or better.

The final exact production-clock runtime protocol is valid: direct/direct
ratios were **0.967 / 1.026 / 1.000** (median **1.000**, every round within the
predeclared 20% bound), while IR/direct ratios were **1.059 / 1.020 / 0.923**
(median **1.020**). The final IR candidate is therefore on par with direct to
within **2.0%** on the full 12-render / 1,120-callback workload. A prior valid
five-round run of the same hot bodies measured IR/direct **0.896**; the final
handover uses the more conservative post-rebase 1.020 result.

This closes only the bounded single-host playground census. It does not make
generic R4 complete or prove repository-wide IR-only readiness. Wider
class/method and closure ownership, generic ordered module init, multi-source
ownership, runtime intents, async-plan removal, shared linear IR, R9 default
selection, and R10 direct-root deletion remain tracked by #3518 and the
adjacent family issues.

Do not create a GitHub Issue for this work. This Markdown record remains the
source of truth for ownership, acceptance, and handover.

### Commit 2 — prepare/lower module init and make fallback one-pass

- Extend from-AST lowering for every planned top-level entry and static intent.
- Prepare/verify the complete unit before body emission and seal its runtime /
  support intents.
- Emit Prepared through IR once. When policy permits Unsupported fallback,
  compile the direct body once after program preparation; remove the snapshot /
  restore and first-pass discovery dependency.

### Commit 3 — planned ABI/start wiring and overlay retirement

- Allocate/resolve the init slot through `ProgramAbiMap` and drive Wasm start,
  deferred-host export, standalone, and WASI adapters from invocation policy.
- Remove flat-name slot discovery, legacy type-index parity patching, and both
  direct-body passes from the Prepared route.
- Delete obsolete module-init claim/patch queues only after parity and
  anti-vacuity evidence is green. Keep the one-pass direct implementation for
  temporary typed Unsupported policy until R9/R10.

## Resume checkpoint — measured remaining gap (2026-08-22)

The Algorithms (#4323) and Calendar (#4395) transactions and the #4566
standalone continuation have all landed. The bounded five-entry playground
census is now **38/38 IR-emitted terminals, 0 legacy bodies, 0 Unsupported,
0 Invariant on BOTH the single-host and standalone lanes**, and
`check:ir-only --policy=ir-only` is `READY`. That census is the *bounded
playground* population; it is not the generic R4 claim, and the numbers below
are the reason.

### What the census does not show

Compiling representative module shapes directly and reading the terminal
outcome plus the `module-init-pass1` / `module-init-pass2` phase counters (the
exact direct-body compile count) gives the honest picture. Measured on
`origin/main` @ `34e102dc8`:

| Source shape | host-start | host-deferred | standalone | wasi |
| --- | --- | --- | --- | --- |
| `const memo = new Map()` | direct 0 · legacy 0 · IR 1 | direct 2 · legacy 1 · IR 1 | direct 0 · legacy 0 · IR 1 | direct 2 · legacy 1 · IR 1 |
| `let v = 7` + TDZ reads | direct 0 · legacy 0 · IR 1 | direct 2 · legacy 1 · IR 1 | direct 0 · legacy 0 · IR 1 | direct 2 · legacy 1 · IR 1 |
| `let total = 0; total = total + 1;` | direct 2 · legacy 1 · IR 1 | (same) | (same) | (same) |
| class + static field/block | direct 2 · legacy 1 · IR 0 (`static-class-initialization`) | (same) | (same) | (same) |
| `const greeting = "hi"` | direct 2 · legacy 1 · IR 0 (`body-shape-rejected`) | (same) | (same) | (same) |
| top-level `var` | direct 2 · legacy 1 · IR 0 (`body-shape-rejected`) | (same) | (same) | (same) |
| function-only / empty | direct 0 · **no module-init outcome row at all** | (same) | (same) | (same) |

Five distinct gaps fall out, in the order R4's own landing sequence wants them:

1. **Every typed Unsupported module-init still compiles the direct body
   TWICE** (`pass1` + `pass2`), in every mode. AC 3 requires exactly one, and
   ordering invariant 6 says restoring two passes is forbidden. This is the
   single largest remaining item and the riskiest: `pass1` exists to populate
   `closureMap` for module-level arrows before any function body compiles, so
   removing it depends on R2/R3's unit inventory genuinely having replaced that
   discovery purpose. Not attempted in this slice.
2. **A module-init that is IR-*patched* but not IR-*owned* records
   `legacy=1, ir=1`** — the #3142 overlay. The `let total = 0; total = …`
   shape is the common case. The exact-lexical selector admits only a gap-free
   run of initialized `let`/`const` declarations, so any executable *statement*
   drops to the overlay. Closing this means extending the selector past
   declarations, which is Commit 2's first bullet.
3. **WASI has no prepared adapter at all** (`ctx.wasi` is an outright
   rejection in `preparedExactLexicalModuleInit`). Admitting it is not a gate
   flip: `applyModuleInitGuard` *mutates* the `__module_init` body after
   emission to add the idempotency guard, which a sealed Prepared body must not
   accept. This needs the invocation-policy-driven adapter of Commit 3, not a
   selector change.
4. **An empty / type-only / function-only module records no terminal outcome
   row.** The *plan* correctly says `executable: false`, but the outcome ledger
   is silent, so AC 7 ("counters reconcile for executable *and empty* modules")
   and anti-vacuity item 7 are both open. `IrObservedOutcome` has no
   non-executable kind, so adding one touches the union and every consumer
   (`check-ir-only`, the route audit, policy evaluation) and moves the census
   denominators — worth doing deliberately, not as a side effect.
5. **Class declarations are still excluded from the module-init population**
   (`collectModuleInitPopulation`, `src/ir/module-init.ts:12-24`), so static
   fields/blocks cannot be represented at their class evaluation position and
   the terminal is `static-class-initialization`-Unsupported. This is R3/#3522
   territory and is deliberately left to that lane.

### Landed in this slice

Gap 3's *host* half — the deferred-export adapter — plus the invocation
reconciliation invariant:

- `preparedExactLexicalModuleInit` now admits the host `deferred-export`
  invocation kind alongside `wasm-start`. The standalone lane already admitted
  it, so the export-alias publication in `preallocateModuleInitCallable` and
  the `skipModuleInitBody` branch of the export wiring are shared machinery.
  Measured effect: the two admitted shapes above move from
  `direct 2 · legacy 1 · IR 1` to `direct 0 · legacy 0 · IR 1` under
  `deferTopLevelInit`.
- The Prepared route reconciles the adapter it actually wired against the
  planned invocation policy and fails closed (ordering invariant 7). The two
  non-WASI adapters are mutually exclusive by construction but are wired from
  `ctx` flags in separate statements, and neither a double-wire (init runs
  twice) nor a missing wire (every binding stays in TDZ) is visible in the
  emitted body.

Observable behavior is unchanged — an A/B against the base file gives identical
runtime results in both host modes. TDZ elision remains gated on `wasm-start`
alone, so the deferred lane keeps its guards, per #4566. The playground census
is unmoved at 38/38.

Anti-vacuity: the direct-body poison seam proves `direct=0` *positively* (an
admitted module compiles with `compileModuleInitBody` poisoned; an unsupported
one fails), and a new `JS2WASM_TEST_MODULE_INIT_DOUBLE_ADAPTER` seam proves the
new invariant is reachable rather than trivially true. Every assertion is
paired with a control that must behave differently.

**R4 is not complete.** Gaps 1, 2, 4 and 5 above are untouched, and each is
larger than this slice. The next slice in the issue's own order is gap 2
(extend the selector past pure declarations), which is the prerequisite for
gap 1 being worth attempting.

## 2026-08-22 next slice plan — exact scalar assignment statement

This is the bounded implementation plan for gap 2 above. It was re-grounded on
upstream `main` `2a6ed4eab0941591ba39678f4743c3268568d693` after the previous
lane handover. The stale `ttraenkler/fable-lead` assignment had no live branch
or registered worktree and is now reconciled to `ttraenkler/codex-ir-lead` on
branch `codex/3523-r4-statement-module-init`. Open-PR and touched-issue-file
scans found no competing #3523/#3142 implementation.

### Measured base and exact target

For the source `let total = 0; total = total + 1;`, selection already claims
the synthetic module-init unit and the #3142 overlay genuinely emits the IR
body. The remaining failure is only Prepared routing:

- `collectModuleInitPopulation` contains one `VariableStatement` and one
  `ExpressionStatement`;
- the semantic plan contains one exact mutable-`let` binding intent and two
  evaluations (`variable-initializer`, then `statement`); and
- `preparedExactLexicalModuleInit` incorrectly requires
  `bindings.length === population.length` and zips bindings, evaluations, and
  statements by one ordinal.

All five measured base modes compile successfully with one `emitted@patch`
outcome, `legacyBodyEmitted: true`, `irBodyEmitted: true`, and exactly one
`module-init-pass1` plus one `module-init-pass2` call. The raw/gzip/WAT sizes
are host start **97/98/258**, host deferred **113/102/282**, standalone start
**719/387/5825**, standalone deferred **735/397/5849**, and WASI
**794/437/6256**.

The candidate moves only the four already-supported host/standalone
start/deferred adapters to one Prepared component with
`legacyBodyEmitted: false`, `irBodyEmitted: true`, and zero calls to both direct
passes. WASI remains the explicit unchanged overlay control
(`legacy=1`, `IR=1`, pass1/pass2 `1/1`) until gap 3. This slice does not attempt
the generic one-pass Unsupported fallback from gap 1.

### Production change

Keep the edit bounded to
`src/codegen/index.ts::preparedExactLexicalModuleInit` (and its immediately
adjacent evidence comment/type). The existing module-init inventory, semantic
plan, selector, AST lowering, integration, Program ABI preallocation, and
declaration routing already support this exact statement. Do not change
`src/ir/module-init-plan.ts`, `src/ir/module-init.ts`, `src/ir/select.ts`,
`src/ir/from-ast.ts`, `src/ir/integration.ts`, or
`src/codegen/declarations.ts` in this slice.

1. Reconcile the population and evaluation stream by evaluation ordinal while
   consuming binding intents independently by `declarationOrdinal`. Keep the
   existing parity requirements over the complete statement population.
2. Preserve the current declaration policy exactly: one initialized,
   single-Identifier `let` or `const`; exact range/kind/mutability/TDZ/global
   and TDZ binding IDs; and one matching `variable-initializer` evaluation.
3. Add one capability arm for
   `ExpressionStatement(BinaryExpression(Identifier, EqualsToken,
   BinaryExpression(Identifier, PlusToken, NumericLiteral)))`. Both
   identifiers must resolve through `ctx.oracle.declarationsOf` to the same
   earlier admitted source `VariableDeclaration`. Its binding must be a mutable
   initialized `let` with the exact planned global binding ID. The matching
   evaluation must be `kind: "statement"`, have the exact
   source/statement ordinal and source range, carry no class ID or binding IDs,
   and be consumed once in source order.
4. Permit zero or more such assignments after admitted declarations without
   folding them into an initializer. The declaration initializes storage and
   transitions TDZ once; the later statement reads and writes the same Program
   ABI global without touching TDZ again.
5. Fail closed before preparation on const writes, `+=`/`++`, forward or
   unknown targets, different-binding RHS, property/element LHS, aliases or
   ambiguous declarations, calls/new/await/yield, non-numeric RHS, function or
   class syntax, destructuring/`var`/multiple or missing initializers, plan
   gaps/parity drift/live seeds, and every existing fast/WASI/strict-host or
   incompatible-provider lane. A mismatch after successful preparation
   remains an Invariant; it may not resurrect the overlay fallback.

The predicate is structural and parameterized over the declaration and literal;
`total` is a fixture label, never an allowlist. Any LOC/function growth must be
factored into a bounded helper or granted in this issue frontmatter; shared
baseline files are not edited.

### Mutation-proof acceptance

Extend `tests/issue-3523-ir-module-init-compile-once.test.ts`; keep
`tests/issue-3142.test.ts` as an adjacent gate unless an existing invariant
requires updating.

- Assert the exact plan shape: one binding, two evaluations in source order,
  first evaluation carrying the binding ID and second carrying none, with
  aligned `2/2` planned/legacy parity.
- Across host start/deferred and standalone start/deferred, require one
  Prepared outcome, `legacy=false`, `IR=true`, a non-empty component ID, zero
  post-claim errors, and the genuine `<module-init>` IR artifact. Started
  lanes read `1` immediately. Deferred lanes throw on the exported read before
  `__module_init`, then read `1`; later reads remain `1` because entry calls do
  not rerun initialization. Do not claim repeated calls to the deferred init
  export are idempotent.
- With `JS2WASM_TEST_POISON_DIRECT_MODULE_INIT_BODY=1`, all four admitted
  compiles must succeed. `total += 1`, a const target, a call RHS, and WASI must
  reach the direct route and fail under the same poison, proving the seam is
  live.
- The observable value `1` is the statement mutation proof; initializer-only
  behavior would return `0`. Temporarily disabling the new arm during review
  must restore `legacy=1, IR=1` and make the poisoned positive fail. This is
  review evidence, not a shipped environment switch.
- Reuse `JS2WASM_TEST_MODULE_INIT_DOUBLE_ADAPTER` with the statement-bearing
  source: the Prepared candidate must fail fatally with no publishable binary,
  while an Unsupported control retains its normal route.
- Pin fail-closed runtime/route controls for const assignment, `+=`, assignment
  before declaration, a different-binding RHS, property LHS, local-call RHS,
  `var`, destructuring, multiple declarations, and WASI.

Compare base and candidate in fresh processes with identical source/options.
Report the outcome tuple, pass1/pass2 counts, runtime/TDZ timing, raw/gzip/WAT,
SHA-256, and deterministic repeat for each lane. Binary identity or shrinkage
is not assumed: if allocation order changes, diff the initializer/start/export
shape and explain it. Routing and runtime behavior are the acceptance bar.

### Coordination and gates

PR #4746 touches `src/codegen/index.ts`; it must land and this branch must
rebase before the production edit/final validation. PR #4747 has no direct
target-file overlap. The fast-`any[]` ABI slice #4615 may run in parallel only
while it stays outside this module-init function.

Run the focused #3523 + #3142 files first with
`VITEST_FORK_MAX_OLD_SPACE_SIZE=4096`, then the issue's seven-file adjacent
matrix. Run hybrid and strict IR-only reports, fallback, typecheck, lint,
Prettier, LOC/function/oracle gates, and all **eight** equivalence shards in
fresh processes. Require no new regression and do not rewrite shared Test262,
equivalence, LOC, or function baselines. Full Test262 remains a merge-queue
gate.

## 2026-08-26 current-main execution lock — scalar assignment statement

This section re-grounded the preceding scalar-assignment plan on `main`
`01a2487abad826a1d75f8c58aef5b58ac332d745`. It is an execution lock for the
bounded slice, not a scope expansion and not evidence that R4 as a whole is
complete.

### Current root cause and authority boundary

The measured failure remains local to
`src/codegen/index.ts::preparedExactLexicalModuleInit`:

- `collectModuleInitPopulation` returns the declaration and assignment, so the
  selector's population is already exhaustive;
- `buildIrModuleInitPlan` correctly records one binding and two ordered
  evaluations; and
- the Prepared predicate still requires `bindings.length ===
  population.length`, indexes a binding by population ordinal, and rejects
  every non-`VariableStatement` population row.

The existing IR lowering already owns the declaration initialization/TDZ
transition and the later module-global read, numeric addition, and write. The
existing integration already lowers every population statement in source
order through one source-owned module-init unit. Therefore this slice changes
no selector, inference, identity, integration, lowering, Program ABI,
declaration-emitter, or runtime-provider file. Its only production owner is
`src/codegen/index.ts`; its only planned test owner is
`tests/issue-3523-ir-module-init-compile-once.test.ts` (with #3142,
**IR module-init overlay adoption (claimability milestone; compile-once
remains)**, and the existing adjacent matrix as read-only controls).

### Exact implementation contract

Retain every existing lane, source/unit identity, invocation, parity, gap,
live-seed, and executable gate. Keep evaluations population-exhaustive, but
consume binding intents independently by `declarationOrdinal`:

1. An admitted declaration remains one initialized, single-Identifier
   `let`/`const` declaration with exact range, kind, mutability, TDZ intent,
   global/TDZ binding IDs, and one exact `variable-initializer` evaluation.
2. The only new statement grammar is
   `Identifier = Identifier + NumericLiteral`. Both identifiers must each
   resolve through `ctx.oracle.declarationsOf` to exactly the same earlier
   admitted declaration. The target must be the initialized mutable `let`;
   textual name equality alone is never evidence.
3. Its evaluation must be the exact next source row: `kind: "statement"`,
   matching source/evaluation and source-file statement ordinals and range,
   `classId: null`, and an empty binding-ID list. Every population row,
   evaluation, and binding is consumed exactly once.
4. Zero or more assignments may follow admitted declarations. No
   parenthesis-normalization, compound/update operator, alternative arithmetic,
   property/element access, alias, call, constructor, await/yield, or generalized
   expression/type inference enters this slice.
5. Const/`var` targets, forward/unknown/ambiguous/different declarations,
   destructuring, multiple/missing initializers, nonnumeric RHS values, plan or
   parity drift, live seeds, WASI, fast, and strict-no-host lanes fail closed on
   the existing route. A post-preparation mismatch remains fatal and may not
   resurrect legacy emission.

This is the smallest honest retirement step: the four already-supported
host/standalone start/deferred lanes must move from `legacy=1, IR=1` and
direct pass1/pass2 `1/1` to `legacy=0, IR=1` and `0/0`. WASI remains the exact
unchanged overlay control. No legacy emitter is deleted in this slice; the
measured removal of four direct invocations is deletion evidence for the later
R4 closeout.

### Publication and overlap protocol

The slice may be developed and committed now in an isolated worktree. These
open PRs are file-collision risks, not semantic prerequisites:

- #4976, **feat(ir): retain dormant #3521 fnctor argument projection ✓**,
  modifies `src/codegen/index.ts` outside this module-init predicate;
- #4974, **fix(es6): combine Test262 conformance wave**, is held and has broad
  `src/codegen/index.ts`/declaration/module-init-collection changes; and
- #4898, **feat(linker): compile npm packages once as linked Wasm providers**,
  is held and also modifies `src/codegen/index.ts`.

At publication, fetch current `main`, inspect an exact merge tree and the
function-local diff, then append current main without rewriting the signed
semantic commit. Any semantic conflict is a HOLD for root review. Held PRs may
not strand the signed checkpoint indefinitely, but if one lands first the
candidate must merge current main append-only and repeat the focused, route,
runtime, ratchet, and hook evidence before enqueue.

The scalar-only source has no class, closure, provider, or import dependency:
#3522, **IR-only R3: compile-once classes, members, and closures**, F1 field
ownership; #3521, **IR-only R2: prepare-before-emit free-function ownership**,
linked-Parser projection; and #4260, **Prepared callable-provider plans leak
across an aborted component seal**, are not prerequisites for this bounded
route. Full R4 still retains the issue's declared R3 dependency and cannot be
called complete from this slice.

Before every heavy command and commit/push boundary, require a fresh finite,
nonnegative one-minute load strictly below `logical cores - 2`. Run the focused
module-init and #3142 overlay-adoption files plus the adjacent matrix, hybrid
and strict IR-only reports, fallback,
typechecks, formatting/lint, all eight equivalence shards, and LOC/function/
oracle ratchets with denominators. Run `pnpm run check:loc-budget` immediately
before every signed commit, and never skip pre-commit or pre-push hooks. Publish
only after an independent exact-head audit proves the bounded two-file semantic
scope and its mutation controls.


## File ownership and locks

One developer owns `src/ir/module-init.ts`, `src/ir/from-ast.ts`,
`src/ir/select.ts`, `src/ir/integration.ts`, `src/codegen/declarations.ts`,
`src/codegen/index.ts`, `src/codegen/context/types.ts`, and the R2 Prepared-
program modules for the entire R4 landing. These files jointly encode ordering,
storage, slot, and invocation invariants and must not be split across parallel
implementation branches.

R3 must land first because it owns class/static-intent and closure inventory.
R5 owns multi-source aggregation; R6 owns runtime-provider semantic entry
points. Coordinate adjacent changes, but do not absorb either scope into R4.

## Anti-vacuity tests

`tests/issue-3523-ir-module-init-compile-once.test.ts` must prove:

1. Interleave observable statements, variable initializers, class declarations,
   static fields, and static blocks. The event log matches source order and
   each event occurs once in ordinary host, deferred host, standalone, and WASI.
2. A reassigned top-level function is readable before reassignment, aliases /
   exports observe the same live binding afterward, and one canonical global is
   seeded once even through multiple aliases (#2931).
3. `let`/`const` reads before initialization throw, post-initialization reads
   succeed, and a throwing initializer does not set its TDZ flag.
4. Static fields/blocks preserve `this`, inheritance, and surrounding binding
   visibility; they are represented inside the plan rather than rejected or
   prepended through `ctx.staticInitExprs`.
5. Repeated `Object.defineProperty`, `freeze`, `seal`, and
   `preventExtensions` operations see the correct program-order state without
   snapshot/restore. A counter seam proves no compiler-side init pass runs twice
   (#2965).
6. A Prepared module records `direct=0, IR=1`; a forced typed Unsupported
   module records `direct=1, IR=0`; post-Prepared failure emits neither a direct
   replacement nor a publishable artifact.
7. An empty/type-only/function-only module records an explicit non-executable
   outcome and adds no `__module_init`, start function, or duplicate export.
8. Top-level throw and side-effect failure surface once with the intended
   source location; the old non-WASI silently-dropped-throw condition cannot
   become parity evidence.
9. `deferTopLevelInit` exports one callable init without a Wasm start section;
   the normal host path uses start once; WASI calling any exported entry first
   still initializes once and `_start` does not repeat it (#1789/#2796).
10. A test seam that deletes a static entry, changes an ordinal, duplicates a
    live seed, resolves by display name, or invokes both start adapters fails
    reconciliation. Simple numeric module-init success alone is vacuous.

Run adjacent regressions from `tests/issue-3142.test.ts`,
`tests/issue-2965.test.ts`, `tests/issue-2796.test.ts`,
`tests/issue-1789-standalone-module-init.test.ts`, `tests/issue-2992.test.ts`,
and `tests/issue-3505-host-compilemulti-harness-callable-init.test.ts`. The last
is a no-regression check only; it does not close R5 multi-source ownership.

## Acceptance criteria

- [ ] Every single-source program has one typed, source-qualified module-init
      outcome before emission; its plan accounts for statements, bindings,
      statics, live seeds, exports, TDZ actions, and invocation policy.
- [ ] Prepared module init emits once through IR and never calls direct
      `compileStatement` / `compileExpression`, patches a legacy-created slot,
      or depends on first-pass compiler mutations.
- [ ] Typed Unsupported module init emits direct once only while hybrid policy
      exists. Invariants and post-Prepared failures are fatal in every policy.
- [ ] Observable top-level/class/static order, TDZ, live bindings, exports,
      side effects, exceptions, and exactly-once behavior match the semantic
      contract across host, deferred host, standalone, and WASI.
- [ ] The two-pass snapshot/restore machinery, module-init name lookup, and
      class/live-seed rejection gates are absent from the Prepared route.
- [ ] `ProgramAbiMap` owns the init function, globals, aliases, and support
      slots; startup adapters consume those identities without display-name
      collision or late allocation.
- [ ] Per-unit and per-emitter counters reconcile for executable and empty
      modules; the readiness gate fails on missing/duplicate outcomes.
- [ ] Full module-init/equivalence/cross-backend tests, typecheck, lint/format,
      merge-group Test262, standalone floor, and Wasm validation are
      net-non-negative.

## Risks and mitigations

- **Source-order regression:** current queues partition statics from statements.
  Use immutable source ordinals and an order verifier; do not infer order from
  registration timing.
- **TDZ/export ABI drift:** moving state allocation can shift globals or expose
  aliases too early. Plan canonical binding slots in R1 and test early/late
  reads plus throwing initialization.
- **Initialization transaction leak:** preparation or lowering may mutate
  compiler state before terminal policy. Seal intents and emit into an isolated
  transaction that publishes only after verification.
- **Double invocation:** Wasm start, deferred export, WASI guards, and `_start`
  currently live in different phases. Represent one invocation policy and
  assert exactly one semantic call per configuration.
- **Accidental R5 coupling:** current `compileMulti` accumulates and replaces
  same-name init exports. Keep R4 acceptance single-source and retain an
  explicit multi-source no-regression test until R5 owns aggregation.

## Out of scope

- Whole-program multi-source/M0 ordering, cross-file imports, cycles, or
  duplicate `__module_init` aggregation (R5).
- Replacing runtime/builtin implementations with semantic IR intrinsics (R6).
- Async/top-level-await ownership or the final unsupported-source policy (R7).
- Shared linear consumption (R8), escape-hatch removal/default flip (R9), or
  direct-handler deletion (#3090/R10).
- Treating #3517's last measured initializer or #3142's narrow claim population
  as proof that this structural issue is already complete.

## Required completion evidence

```bash
pnpm exec vitest run tests/issue-3523-ir-module-init-compile-once.test.ts tests/issue-3142.test.ts tests/issue-2965.test.ts tests/issue-2796.test.ts tests/issue-1789-standalone-module-init.test.ts tests/issue-2992.test.ts tests/issue-3505-host-compilemulti-harness-callable-init.test.ts --pool=forks --poolOptions.forks.singleFork=true --no-file-parallelism
pnpm run check:ir-only -- --policy=hybrid
pnpm run check:ir-only -- --policy=ir-only --json
pnpm run check:ir-fallbacks -- --verbose
pnpm run typecheck
pnpm run lint
pnpm run format:check
node scripts/equivalence-gate.mjs
pnpm exec vitest run tests/cross-backend-diff.test.ts --pool=forks --poolOptions.forks.singleFork=true --no-file-parallelism
```

The PR report must include the ordered plan dump, terminal outcome, direct/IR
emission counts, support-unit counts, startup invocation count for every mode,
and before/after proof that no legacy slot was created or patched for a
Prepared module. A green numeric initializer with no statics, TDZ, aliases, or
startup-mode matrix does not close R4.

## 2026-08-26 scalar-assignment checkpoint publication record

Publish the bounded scalar-assignment retirement as an independently reviewable
checkpoint rather than holding it behind the rest of R4. The semantic diff is
restricted to `src/codegen/index.ts` and
`tests/issue-3523-ir-module-init-compile-once.test.ts`: consume binding intents
by `declarationOrdinal`, keep evaluations population-exhaustive, and admit only
an exact source-local mutable `let` assignment of the form
`Identifier = same-Identifier + NumericLiteral` after all admitted lexical
declarations. Every declaration, binding, evaluation, source range, and oracle
identity must join exactly; all adjacent syntax and authority shapes remain on
the existing route.

The existing `loc-budget-allow` for `src/codegen/index.ts` applies to this
checkpoint because the added code is the fail-closed Program-ABI join and its
bounded route predicate, not a general lowering expansion. The PR must report
the exact net delta and still run `check:loc-budget` immediately before the
signed semantic commit. It must also prove four host/standalone start/deferred
lanes emit the module-init body through IR only, preserve runtime/TDZ behavior,
and bypass the direct emitter; WASI and malformed/near-miss sources remain
unchanged controls.

This checkpoint does not complete R4, delete the legacy module-init emitter, or
weaken any dependency. It may merge independently after the focused matrix,
hybrid and strict IR-only reports, fallback/type/format checks, all equivalence
shards, regrowth ratchets, full unskipped commit/push hooks, and an independent
exact-head audit pass.

### Signed semantic checkpoint evidence

The exact signed semantic checkpoint is
`81244c155890210a5962c5b67066c2041caea8d9` (stable patch ID
`e27620d2fe5c8384d82439c902bbf767b5d5fbc1`). Its two-file semantic diff is
`src/codegen/index.ts` +229/-59 and the focused root test +267/-0. The source
file grows from 12,246 to 12,416 lines (+170) under this issue's existing
allowance; function budget and checker-usage growth remain zero.

The focused root test passes 19/19. The seven-file adjacent matrix is 62/68:
all six non-passing rows reproduce exactly on an untouched current-main
control (three #3142 expectations, one host-engine exnref limitation in #2965,
and two #3505 rows whose optional `test262-fyi/data` checkout is absent).
TypeScript 7 and TypeScript 5, fallback, hybrid, strict IR-only, scoped format,
lint, LOC, function, oracle, and full unskipped pre-commit gates pass. Hybrid
and strict reports both show, per host and standalone lane, 38/38 emitted IR
terminals with legacy, Unsupported, and Invariant counts all zero.

All eight equivalence shards pass with 1,661 passing, 24 known, and zero new
failures. Every successful heavy command and the commit boundary used a fresh
finite, nonnegative one-minute load below the 10-core host's strict limit of 8;
one earlier shard-6 sample of 10.086 correctly prevented child execution and a
fresh 6.110 replay supplied the accepted result. The semantic checkpoint is
not publication acceptance until it is reconciled append-only with current
main, independently audited at the exact final head, and passes the full
unskipped pre-push hook.

## 2026-08-28 landed-record note — the scalar-assignment checkpoint is ON MAIN

The 2026-08-26 signed semantic checkpoint (`81244c1558…`, branch
`codex/3523-r4-statement-module-init`) was believed orphaned after its branch
disappeared from origin unpushed. A clean-room re-implementation attempt on
2026-08-28 found **the content is already on current main** and stopped without
duplicating:

- `isPreparedExactScalarModuleAssignment` (src/codegen/index.ts ~3954-4018) and
  `preparedExactLexicalModuleInit` (~4020-4148) implement the contract verbatim
  (declarationOrdinal-keyed intents, population-exhaustive evaluations,
  `sawAssignment` ordering guard).
- The focused root suite `tests/issue-3523-ir-module-init-compile-once.test.ts`
  passes **19/19** on main — the exact count the publication record claims —
  including the 16 near-miss fail-closed controls.
- Five-lane probe on main: host/standalone × start/deferred all compile the
  scalar-assignment module with `legacy=false, IR=true` and a live prepared
  terminal; runtime witness `read() = 1`; the
  `JS2WASM_TEST_POISON_DIRECT_MODULE_INIT_BODY=1` poison run proves the four
  admitted lanes bypass the direct route while WASI (control) still fails on
  the injected poison.
- Landing provenance: the content is present at the shallow-clone graft base
  dated 2026-08-26 18:09 UTC, so it reached main the same day the checkpoint
  was signed; the exact carrying PR is below the shallow horizon.

The closing sentence of the 2026-08-26 publication record ("not publication
acceptance until it is reconciled append-only with current main…") is
therefore SUPERSEDED — the reconciliation happened.

**R4 remains open.** Per the 2026-08-22 census only gap 2 (this slice) is
closed. The natural next slice is **gap 1: every typed-Unsupported module-init
still compiles the direct body twice (pass1 + pass2)** — the largest remaining
item; then gap 3 (WASI prepared adapter), gap 4 (empty/function-only modules
record no terminal outcome row), gap 5 (class declarations in the module-init
population — R3/#3522 territory).

## 2026-08-29 gap-1a implementation plan — single direct compile for call-free module inits

**Fable lane.** Grounded on `origin/main` merged at `fe3fe11e52` (probe
`.tmp/r4gap1-census.mts`, `JS2WASM_COMPILE_PROFILE=1`, reading the
`module-init-pass1`/`module-init-pass2` phase `calls` counters — the census's
"direct N" column). Opus implements against this plan.

### Measured census (current main)

| shape | host | standalone | init outcome |
| --- | --- | --- | --- |
| `const memo = new Map()` | 0/0 | 0/0 | emitted (IR-owned) |
| `let v = 7` + TDZ read | 0/0 | 0/0 | emitted |
| `let total = 0; total = total + 1;` | 0/0 | 0/0 | emitted (gap 2 landed) |
| class + `static n = 3` | **1/1** | **1/1** | unsupported:static-class-initialization |
| `const greeting = "hi"` | **1/1** | **1/1** | unsupported:body-shape-rejected |
| top-level `var w = 5` | **1/1** | **1/1** | unsupported:body-shape-rejected |
| `const f = (x) => x*2` | **1/1** | **1/1** | unsupported:body-shape-rejected |
| `let z = h();` (call in init) | **1/1** | **1/1** | unsupported:call-graph-closure (#2855 warning channel) |
| `Object.freeze(o)` in init | **1/1** | **1/1** | unsupported:body-shape-rejected |
| function-only module | 0/0 | 0/0 | no outcome row (gap 4, separate) |

The IR-prepared route now fully suppresses both passes in both admitted lanes
(direct 0). **Every typed-Unsupported module-init still compiles the direct
body twice** — pass 1 + pass 2 — in every mode. That is gap 1, unchanged since
the 2026-08-22 census.

### Why two passes exist (verified against `src/codegen/declarations.ts` on the grounded tree)

- **Pass 1** (`:5096`) runs before top-level function bodies to "seed
  closure/setup discovery": compiling the init entries registers module-level
  closures, string constants, and setup state that the function bodies
  compiled after it consume. Function bodies also deliberately observe pass
  1's END integrity state (`frozenVars` etc. — the #2965 comment at `:4860`).
- **Pass 2** (`:5278`) recompiles after function bodies **for exactly one
  stated reason**: "so call sites inside module-level code can see the final
  inlinable-function registry" (`registerInlinableFunction` entries appear as
  function bodies compile). `restorePropOrderState()` (`:5277`) resets the
  order-sensitive maps so pass 2 compiles from the same initial state, and
  `dedupeDiagnosticsFrom` (`:5280`) reconciles the doubled diagnostics.
- The emitted body is `compiledInitFctx?.body` (`:5305`), i.e. whichever pass
  ran last, and `ctx.pendingInitBody` is index-maintained across everything
  compiled between the passes: module-global shifts
  (`src/codegen/registry/imports.ts:425`), late func-index shifts (`:713`,
  `:1027`) all patch the pending body. **Pass 1's body is therefore kept
  structurally valid to the end already** — that machinery is what makes this
  slice small.

Existing scars of the double compile, all of which this slice retires for the
gated population: #2965/#3872 prop-order snapshot/restore, #4195 diagnostic
double-report dedupe, the per-pass `capturedGlobals` reset (`:4920`-area
comment), and the #4182 Annex-B seed divergence (fixed by making the preamble
decision pass-invariant — the precedent that pass-1/pass-2 preambles must not
consult state that grows between passes).

### The slice: skip pass 2 when the init population is call-free

A pass-2 recompile can only differ from pass 1's (fixup-maintained) body
through the inlinable-function registry, and that registry is consulted only
at call sites. So:

**Gate.** Immediately before the pass-2 block (`:5273`), compute
`initPopulationIsCallFree`: a full-subtree scan over exactly the inputs
`compileModuleInitBody` compiles — every `ctx.moduleInitStatements` statement
and every `ctx.staticInitExprs` entry's `staticBlock ?? initializer` (the
`orderedInitEntries` construction at `:5015`-`:5040` names the exact set).
Refuse (keep two passes) on ANY of: `CallExpression` (covers `super(...)`),
`NewExpression`, `TaggedTemplateExpression`, `Decorator`, `AwaitExpression`.
The scan includes nested arrow/function/class-expression bodies inside
initializers (a `const f = () => h()` closure body compiles during the init
statement and would otherwise bake pass-1's un-inlined call in). Anything not
provably call-free keeps today's two passes — fail closed, no allowlist.

**Skip.** When the gate holds and the pass-2 condition
(`moduleInitMode === "full"` etc.) is met: do not run pass 2, do not
`restorePropOrderState()` (nothing recompiles), and do **not** call
`dedupeDiagnosticsFrom` (there is no doubled range; calling it against a
single pass would be wrong). Pass 1's `compiledInitFctx` remains the emitted
body — already the variable the injection reads.

**Census truth.** The skip must be observable: keep the
`module-init-pass1`/`-pass2` profile phases as-is (a skipped pass simply
records no pass-2 call), so the probe above reads `1/0` for gated shapes.

### Constraints (each one is a test)

1. **The gate scans the exact compile inputs, not the source file.** A call
   inside a top-level function body must NOT disqualify (function bodies are
   not init inputs); a call inside a static block or a class-expression method
   in an initializer MUST disqualify.
2. **Preamble emissions must remain pass-invariant** — the seeds
   (`emitModuleVarUndefinedSeeds`, function-binding/Annex-B seeds,
   `emitScriptGlobalVarBindings`, `liveFuncBindingGlobals` closures) are
   emitted by pass 1 and stand. #4182 already made the one known
   pass-sensitive preamble decision static; no new dependence may be
   introduced.
3. **Multi-source: the accumulated population decides.**
   `ctx.moduleInitStatements`/`ctx.staticInitExprs` are per-graph accumulated
   state; the scan runs over the full accumulated set at the emitting source's
   pass-2 site, so a call-bearing statement contributed by an EARLIER source
   keeps two passes even when the emitting source's own statements are
   call-free. `"discover"`/`"skip"`/`"prepared"` modes are untouched.
4. **Diagnostics parity.** For a gated shape with a compile error in an init
   statement, the error appears exactly once (today: twice + dedupe). The
   dedupe call must still run whenever pass 2 ran.
5. **No behavior widening.** This slice does not touch the IR selector, the
   prepared route, `applyModuleInitGuard`, or invocation wiring. It changes
   how many times the DIRECT body compiles, nothing about what it contains
   for call-free inputs.

### Mutations / anti-vacuity

Add `tests/issue-3523-module-init-single-pass.test.ts`:

- **Gated shapes** (string const, top-level `var`, arrow initializer, object
  literal, static `n = 3` class): profile census `pass1=1, pass2=0`; runtime
  A/B parity (exports + observed values) against a forced-two-pass control.
  Add a test-only `JS2WASM_TEST_FORCE_MODULE_INIT_PASS2=1` seam that restores
  the old unconditional recompile for exactly this comparison; the seam must
  not otherwise alter either route.
- **Control shapes** (call in init, `new` in init, call inside a static
  block, call inside an initializer arrow body, tagged template): census
  stays `pass1=1, pass2=1` and behavior is unchanged.
- **Non-vacuity**: `JS2WASM_TEST_POISON_DIRECT_MODULE_INIT_BODY=1` still
  fails a gated shape (proves pass 1 runs; the skip must not silently skip
  BOTH passes).
- **Diagnostics**: a gated shape with a deliberate init-statement error
  reports it exactly once; a control shape also exactly once (dedupe path).
- **Inlining regression guard (the reason pass 2 exists)**: a control with a
  module-level call to a top-level function must produce the same body bytes
  as before this change (pass 2 still supplies the final registry there).
- **IR-owned and fn-only shapes**: stay `0/0`; the gate must not create an
  outcome row or touch the prepared route (run beside
  `tests/issue-3523-ir-module-init-compile-once.test.ts`).

Byte-equality between the gated route and the forced-two-pass control is NOT
required (pass 2 may currently emit deduped closure twins); runtime parity,
export surface, import surface, and Wasm validity are.

### Explicitly out of scope (the rest of gap 1)

Call-bearing typed-Unsupported inits keep two passes. Retiring pass 1 itself
(the discovery purpose) requires the R2/R3 unit inventory to supply
closure/setup discovery ahead of body compilation — that is the follow-up
slice, not this one. Gaps 3 (WASI adapter), 4 (non-executable outcome row) and
5 (class population) are unchanged.

### Validation

Focused suite + `tests/issue-3523-ir-module-init-compile-once.test.ts` +
`tests/issue-2965*`/`#3872`/`#4195`/`#4182` families if present; typecheck;
`pnpm run check:ir-fallbacks` bare; ratchet chain bare
(`node scripts/check-loc-budget.mjs && node scripts/check-func-budget.mjs &&
node scripts/check-coercion-sites.mjs && npm run -s check:oracle-ratchet &&
npm run -s check:dead-exports`), plus the `LOC_GATE_BASE=$(git rev-parse
origin/main)` CI-base simulation. Hooks run without bypass. Acceptance: gated
census rows read `1/0`, controls `1/1`, IR-owned `0/0`, all constraint tests
green.

### 2026-08-29 gap-1a implementation checkpoint (Opus lane)

**Branch** `claude/issue-3523-gap1a-single-pass`, based on `origin/main` at
`fe3fe11e52`. Implemented exactly the slice above; nothing widened.

**Re-verification before coding.** Every cited site was re-located by symbol,
not line number, and the plan's line numbers were all off by a few (the file
had drifted): pass 1 is at `declarations.ts:5096`, pass 2 at `:5278`,
`restorePropOrderState` at `:4887`, `dedupeDiagnosticsFrom` (import) at `:61`
and its call at `:5280`, `orderedInitEntries` at `:5023`-`:5040`,
`compiledInitFctx?.body` at `:5304`, and the `pendingInitBody` fixups in
`src/codegen/registry/imports.ts` at `:425`, `:713`, `:1027`. All named
mechanisms exist as described.

The census probe was re-run first on the untouched tree
(`.tmp/r4gap1-census.mts`, `JS2WASM_COMPILE_PROFILE=1`, `target: "standalone"`
for the standalone lane) and **reproduced the plan's table exactly**, including
the three `0/0` IR-owned rows and the six `1/1` typed-Unsupported rows, in both
lanes.

**Change.** Two files:

- `src/codegen/declarations/module-init-call-free.ts` (new, 95 lines) —
  `moduleInitPopulationIsCallFree(ctx)`, an iterative full-subtree scan over
  `ctx.moduleInitStatements` plus each `ctx.staticInitExprs` entry's
  `staticBlock ?? initializer`, refusing on `CallExpression`, `NewExpression`,
  `TaggedTemplateExpression`, `Decorator` and `AwaitExpression`.
- `src/codegen/declarations.ts` (+11 net) — the pass-2 block now runs only
  when `JS2WASM_TEST_FORCE_MODULE_INIT_PASS2 === "1"` or the population is not
  provably call-free. `restorePropOrderState()` and `dedupeDiagnosticsFrom()`
  moved inside that guard, per the plan.

**Post-change census** (same probe): gated shapes `1/0`, controls `1/1`,
IR-owned and function-only `0/0`, in both lanes. With
`JS2WASM_TEST_FORCE_MODULE_INIT_PASS2=1` every row returns to the pre-change
`1/1`, so the seam is a faithful control.

**Empirical check of the plan's central claim** ("a pass-2 recompile can only
differ from pass 1's fixup-maintained body through the inlinable-function
registry"). Two independent probes:

- A source-level audit found `ctx.inlinableFunctions` read in exactly two
  places: `expressions/call-identifier.ts:2962` (a call site) and
  `runtime-module-callable-metadata.ts:43`, which only saves/restores
  name-keyed state around namespace-scoped compilation and makes no codegen
  decision from it. The preamble's one conditional path
  (`emitCachedFuncClosureAccess` → `ensureFuncClosureSingleton` →
  `normalizeOrdinaryFunctionConstructibility`) resolves from
  declaration-derived state only, never from compiled function bodies —
  which is what constraint 2 requires, and what the #4182 comment and the
  "identical across passes" note at `method-trampolines.ts:1018` already
  assert by design.
- A whole-corpus A/B (`.tmp/r4gap1-corpus-ab2.mts`): all 25
  `website/playground/examples/**` + `examples/**` sources compiled in both
  lanes, single-pass vs `JS2WASM_TEST_FORCE_MODULE_INIT_PASS2=1`. **50/50
  byte-identical binaries**, identical success flags and error counts, zero
  divergences. Byte equality is not asserted in the test suite (the plan does
  not require it), but it is the measured outcome on this corpus.

**Divergence from the plan (one, benign).** Constraint 1's example "a call
inside a class-expression method in an initializer MUST disqualify" holds only
when that statement actually reaches the init population. `const K = class {
m() { return h(); } };` with **no** class-expression statics is deliberately
NOT pushed to `ctx.moduleInitStatements` (`declarations.ts:3658`-`:3668` —
reads use the canonical class singleton), so it is not a compile input and
correctly stays gated at `1/0`. Adding a static to the same class expression
puts the statement in the population and the method-body call then disqualifies
it (`1/1`), which is the behavior the constraint is about. The test encodes
the reaching case. Symmetrically, a class **declaration** whose methods contain
calls but whose static field is call-free stays gated — only
`staticBlock ?? initializer` are init inputs there, and that is exactly what
constraint 1's first half demands.

**Tests.** `tests/issue-3523-module-init-single-pass.test.ts`, 9 cases, green
under CI's flags (`--pool=forks --poolOptions.forks.singleFork
--no-file-parallelism`): gated census `1/0` ×5 shapes ×2 lanes; forced-two-pass
A/B parity on runtime value, export names, import descriptors and
`WebAssembly.validate`; control census `1/1` ×5 shapes ×2 lanes with unchanged
runtime values; the compile-inputs-not-source-file constraint (function-body
call does not disqualify; static block and reaching class-expression method
do); the multi-source accumulated-population constraint (`2/0` when both
sources are call-free, `2/1` when the dependency contributes the call);
diagnostics parity (`Cannot destructure: not an array type` reported exactly
once on the gated route, exactly once on the control's dedupe route, exactly
once under the forced seam); non-vacuity via
`JS2WASM_TEST_POISON_DIRECT_MODULE_INIT_BODY=1` (a gated shape still fails, so
pass 1 demonstrably runs, while an IR-owned shape stays unaffected); the
inlining regression guard (`const v = twice(21)` is byte-identical to the
forced-two-pass build and still reads 42); and IR-owned/function-only shapes
pinned at `0/0`.

**Adjacent families.** `tests/issue-2965`, `issue-4182-annexb-global-blockfn`,
`issue-4195-eval-refusal-message-and-dedupe`, `issue-2766`,
`issue-2856-nonterminating-if-guard`, `issue-3734-i32-array-elements`,
`issue-4110-ir-fetch-all-parallel`, `tests/ir/passes` — all green. Seven
failures in `issue-3523-ir-calendar-retirement` (1),
`issue-3523-ir-module-init-compile-once` (1, "keeps duplicated class-expression
static queues observational") and `issue-3872` (5) **reproduce identically on
an untouched `fe3fe11e52` control** measured by file-copy revert in this same
worktree, so they are pre-existing and not touched by this slice.

**Gates.** `pnpm run typecheck`, `pnpm run check:ir-fallbacks` (OK, no
unintended/post-claim/module-level increases), `check-coercion-sites`,
`check:oracle-ratchet`, `check:dead-exports` all pass bare. LOC and function
budgets report `src/codegen/declarations.ts` +11 and
`compileDeclarations` +10, both covered by this issue file's existing
`loc-budget-allow` / `func-budget-allow` entries — restated here because the
gate reads allowances only from plan files the change-set itself touches.

## 2026-08-31 gap-4 implementation plan — a non-executable module records a truthful outcome row

**Fable lane.** Grounded on `origin/main` at `87002f1fe4`. Gap 4 of the
2026-08-22 census: an empty / type-only / function-only module records **no
module-init outcome row at all** — the plan correctly says `executable: false`
(`buildIrModuleInitPlan`, `src/ir/module-init-plan.ts:495`:
`executable = liveSeeds.length > 0 || evaluations.length > 0`), but the
observed-outcome ledger is silent. R4's AC 7 ("counters reconcile for
executable *and empty* modules") and anti-vacuity item 7 stay open, and every
census consumer's denominator silently under-counts. Confirmed live on the
gap-1a probe (2026-08-29): the function-only shape reports `0/0` passes and
**no outcome row** in both lanes.

### Measured facts

- The outcome union (`src/ir/outcomes.ts:281`) has exactly three kinds:
  `emitted` | `unsupported` | `invariant` (`IrObservedOutcomeBase &
  IrPreparationFailure`). There is no way to state "nothing to do" truthfully.
- `evaluateIrOutcomePolicy` (`:317-336`) blocks every non-`emitted` row under
  `ir-only` and requires `legacyBodyEmitted` on `unsupported` — a
  non-executable init can satisfy neither, which is WHY no row is recorded
  today rather than a fabricated one. The M2 multi-source lock's refusal of
  "fabricated empty-source terminal outcomes" is about fabricating
  ownership/prepared evidence; an honest observational "non-executable" row is
  a different animal and must be designed as one.
- The executable→unit invariant is one-directional
  (`module-init-plan.ts:497`: `executable && unitId === null` fails); nothing
  yet establishes whether the identity inventory mints a module-init unit for
  an EMPTY population — probe P1 below decides the row's `unitId` contract.
- The module-init recording arm lives in
  `src/codegen/ir-overlay-outcomes.ts` (`expectedKind: "module-init"` at
  `:662`, the `unitKind === "module-init"` join at `:724`).
- Body-emission accounting (`hasMalformedBodyEmissionAccounting`, `:297`)
  requires `prepareAttempts === 1` when counters are present — a
  non-executable row must OMIT all three counters and carry both booleans
  false.

### Contract

Add one union arm, restricted by construction:

```ts
| (IrObservedOutcomeBase & {
    readonly kind: "non-executable";
    readonly stage: "select";
  })
```

- Only `unitKind: "module-init"` rows may carry it (a validator, not a comment).
- `legacyBodyEmitted: false`, `irBodyEmitted: false`, no emission counters.
- Exactly ONE such row per source whose module-init plan says
  `executable: false` — including every empty source of a multi-source graph
  — recorded at the same site that records executable module-init outcomes,
  keyed by the same source/unit identity discipline (P1 decides whether
  `unitId` is required or structurally absent for empty populations; either
  answer is encoded as a fail-closed check, never left optional-by-accident).
- `evaluateIrOutcomePolicy`: a well-formed `non-executable` row is a blocker
  under NEITHER policy — add its arm explicitly before the ir-only fallthrough
  (`:333` currently blocks everything non-emitted). A `non-executable` row
  with any body evidence, counters, or a non-module-init `unitKind` IS a
  blocker (malformed evidence, both policies).

### Consumers (each is one bounded edit + one test)

1. `scripts/check-ir-only.ts` — the census gains a `non-executable` column;
   denominators now include these rows. The committed
   `scripts/ir-only-baseline.json` moves — this is the ONE sanctioned baseline
   edit and must be regenerated by the tool, never by hand.
2. `src/codegen/legacy-body-audit.ts` — a non-executable init has zero
   `compileModuleInitBody` roots; assert the join rather than skipping it.
3. `src/codegen/multi-prepared-program.ts` (M0 owner) — P2 below: establish
   whether the owner's terminal denominators would double-count or reject the
   new rows; the owner's census is by `IrUnitId`, so if P1 says empty
   populations have no unit, the rows live OUTSIDE the terminal denominator
   and the owner is untouched — state which, with evidence.
4. `src/codegen/ir-overlay-outcomes.ts` — the expectedKind/authentication arm
   admits the new kind for module-init only.

### Required pre-implementation probes (answers go in the checkpoint note)

- **P1**: does `buildIrUnitInventory`/`buildIrPlanningIdentityContext` mint a
  module-init unit for an empty population (`moduleInitUnitIdBySourceFile`
  entry for a function-only source)? Decides the row's identity contract.
- **P2**: compile a function-only single source and a two-source graph (one
  empty) with `trackIrOutcomes: true` on the unmodified tree; record exactly
  which validations fire when a synthetic non-executable row is injected into
  the ledger — that is the fail-closed surface the new arm must thread.
- **P3**: `check:ir-only`'s current denominator on its five entries — before
  number, so the after number is a measured delta, not an assertion.

### Tests / anti-vacuity (new `tests/issue-3523-non-executable-outcome.test.ts`)

- Function-only, type-only, and truly-empty sources each record exactly one
  `non-executable` module-init row, both lanes; the executable control records
  its `emitted` row and NO non-executable row.
- Multi-source: empty dependency + executable entry → one `non-executable` +
  one executable row, sources correctly attributed; two empty sources → two
  rows, distinct source ids.
- Policy: `ir-only` verdict on a ledger containing a well-formed
  `non-executable` row is `ready` when everything else is emitted; mutations
  (counters present, a body boolean true, `unitKind: "function"`, duplicate
  row per source, `stage` ≠ select) each reject as blockers or fail closed at
  recording.
- The census gate reports the new column and its baseline regeneration is in
  the PR.
- Non-vacuity: reverting only the recording-site change (schema kept) makes
  the per-source-row tests fail.

### Out of scope

Gap 1's call-bearing remainder (pass-1 retirement), gap 3 (WASI adapter), and
gap 5 (class population, R3). No selector or prepared-route change; this slice
only makes the ledger stop lying by omission.

### Validation

Focused suite + `tests/issue-3523-ir-module-init-compile-once.test.ts` +
`tests/issue-3523-module-init-single-pass.test.ts`; `pnpm run check:ir-only`
(regenerated baseline); `pnpm run check:ir-fallbacks` bare; typecheck; ratchet
chain bare + `LOC_GATE_BASE` CI-base simulation; hooks without bypass.

## 2026-08-31 gap-4 checkpoint note — probes P1–P3 answered (Opus implementation lane)

Branch `claude/issue-3523-gap4-outcome-row`, grounded on `origin/main` at
`bdd5478d`. Probes run on the **unmodified** tree before any edit.

### P1 — does the identity inventory mint a module-init unit for an empty population?

**No. `unitId` is structurally ABSENT for every non-executable source.**

`IrUnitInventoryScanner` mints the module-init terminal only under
`modulePopulation.length > 0 || firstStaticInitialization`
(`src/ir/identity.ts:878`), and `collectModuleInitPopulation`
(`src/ir/module-init.ts:9`) excludes function/class/interface/type-alias/
import/export/empty statements. Measured across six shapes
(`buildIrUnitInventory` → `buildIrPlanningIdentityContext` →
`buildIrModuleInitPlan`, `target: "host"`):

| shape | `plan.executable` | `plan.unitId` | inventory unit | seeds | evals |
| --- | --- | --- | --- | --- | --- |
| function-only | false | null | none | 0 | 0 |
| type-only | false | null | none | 0 | 0 |
| truly-empty | false | null | none | 0 | 0 |
| class-no-static | false | null | none | 0 | 0 |
| class-static-only | **true** | set | set | 0 | 1 |
| executable control | **true** | set | set | 0 | 1 |

**`executable === false` ⟺ `plan.unitId === null` ⟺ no inventory module-init
unit**, with no divergence in any probed shape — including both class shapes,
which were the plausible counterexample (a static initializer makes the source
*executable*, so it keeps its unit and its existing row; it is NOT gap-4
population).

**Identity contract, therefore fail-closed in the direction P1 measured:** a
`non-executable` row carries `sourceId` and **must NOT carry `unitId`**. This is
encoded as a validator, not a convention — `nonExecutableOutcomeDefect` rejects
a `non-executable` row bearing a `unitId`, and the recording site is guarded by
`plan.executable === false && plan.unitId === null` so a future divergence
between the two cannot silently mint a row with borrowed identity. The
executable→unit invariant stays one-directional as it was; this adds the
non-executable→no-unit direction rather than widening the existing one.

### P2 — the fail-closed surface an injected row hits

A well-formed synthetic `non-executable` row injected into the real five-entry
ledger on the unmodified tree fires exactly these, and no others:

1. **`evaluateIrOutcomePolicy` (`src/ir/outcomes.ts:333`)** — blocker under
   `ir-only` (`ready=false`, 1 blocker, the synthetic row), **not** a blocker
   under `hybrid` (`ready=true`). It reaches the ir-only fallthrough and is
   caught by `!outcome.irBodyEmitted`. This is the arm the contract adds
   explicitly; note the row is *already* correctly policy-neutral under hybrid,
   so only the ir-only path needs the new arm.
2. **`scripts/check-ir-only.ts:377`** — `single-host: IR emitted 38/39 terminal
   source units`. The compile-once assertion equates `irBodyEmitted` with
   `terminalUnits`, so a row that by construction has no IR body to emit breaks
   it. The census must subtract the non-executable rows from the *expected IR
   body* side while still counting them as recorded rows.
3. **`src/codegen/legacy-body-audit.ts:421`** — `unknown-outcome-unit`
   (`"<module-init> has no exact terminal inventory identity"`), because the
   join is keyed on `outcome.unitId` being present in `terminalByUnitId`. Per
   the plan this is asserted, not skipped: the new arm is admitted only when the
   source genuinely has zero module-init terminal and zero
   `compileModuleInitBody` root.

Nothing else fired. In particular the duplicate-key, `legacyBodyEmitted`-boolean,
`emitted`-without-IR-body, non-emitted-claiming-IR-body,
`unsupported`-without-legacy-body, `irCompiledFuncs`/`irFirstSkipped`
cross-checks and the invariant ceiling were all silent on the injected row.

### P3 — `check:ir-only` denominator BEFORE

`pnpm run check:ir-only` on `bdd5478d`, verdict **READY**, both lanes identical:

```
entries 5/5 · terminal units 38 · emitted 38 · unsupported 0 · invariants 0
legacy body emitted 0 · IR body emitted 38
by unit kind {"function":26,"module-init":2,"class-member":10}
```

**Gap-4 population, measured per entry** (module-init rows today):

| entry | rows | module-init |
| --- | --- | --- |
| `dom/calendar.ts` | 10 | 1 |
| `js/algorithms.ts` | 7 | 1 |
| `js/async.ts` | 6 | **0** ← gap-4 |
| `js/builtins.ts` | 4 | **0** ← gap-4 |
| `js/classes.ts` | 11 | **0** ← gap-4 |

So the expected after-delta is **+3 rows per lane** (38 → 41 terminal units,
`non-executable` 3), `emitted` and `IR body emitted` unchanged at 38. That is a
measured prediction from the before-state, and the regenerated baseline is the
check on it — not an assertion.

### Divergences from the plan

None falsifying. Two refinements the probes forced, both narrowing:

- The plan left P1's answer open ("required or structurally absent"); it is
  **structurally absent**, so the contract is a *prohibition* on `unitId`.
- The plan's "exactly ONE such row per source whose module-init plan says
  `executable: false`" is implemented as `executable === false && unitId ===
  null`. P1 measured these to be the same set, and the conjunction is the
  fail-closed spelling: were they ever to diverge, the source keeps its existing
  unit row and gains no second row, rather than double-counting.

### Consumer 3 (M0/M2 owner, `src/codegen/multi-prepared-program.ts`): UNTOUCHED, with evidence

The plan allowed this to resolve either way. It resolves to **untouched**, and
the evidence is structural rather than an absence of observed failures:

- The owner's terminal census is keyed by `IrUnitId` throughout —
  `#moduleInitAudit` iterates `preparation.sourcePlans` (`sourceId`/`unitId`/
  `executable`), and `#recordModuleInitIrTelemetry` guards against a duplicate
  row with `outcome.unitId === preparation.unitId || outcome.key ===
  terminal.legacyKey`. Per P1 a `non-executable` row has NO `unitId`, so it
  cannot enter either denominator.
- The `key` half of that guard cannot collide either: both keys are prefixed by
  their own source's `fileName`, and a source that owns a prepared module-init
  terminal is excluded from the new row by construction. The two key spaces are
  therefore disjoint by source, not by luck of ordering.
- The publication prefix guard in `multi-prepared-callable-publication.ts`
  (`#assertContextPrefixes`) asserts `ctx.irOutcomes` is unchanged in identity
  AND contents across the publication window. The new row is appended in
  `recordObservedIrOutcomes`, outside that window; measured on the two
  multi-source graphs below, no publication error occurs.

Measured (`compileMulti`, `trackIrOutcomes: true`):

| graph | non-executable rows | distinct sourceIds | audit violations |
| --- | --- | --- | --- |
| empty dependency + executable entry | 1 (on `dep.ts`) | 1 | 1, **pre-existing on `origin/main`** |
| two statement-free sources | 2 | 2 | 0 |

The single violation in the first graph is
`unresolved-legacy-entry: compileModuleInitBody __module_init has no exact
source/unit/class identity`, and it is present **verbatim on `origin/main`**
for the same input (measured by file-copy A/B). It belongs to gap 1's
whole-program `__module_init`, not to this slice, and is left alone.

### One narrowing forced by that measurement

The audit-join guard's first cut counted a source as owning a physical module
init from any `compileModuleInitBody` entry carrying a `sourceId`. That is
unsound: the whole-program `__module_init` entry carries the *ambient* source
being compiled, which the audit itself already reports as having no exact
identity. It made the innocent empty dependency in graph 1 look like it owned a
module-init body, producing a spurious second defect. The guard now counts only
roots whose `unitId` resolves to a module-init terminal — exact identity, never
ambient attribution. Using evidence the audit has already declared unresolved
would have been the same class of error this slice is removing.

### Test-surface changes (fix-on-touch)

`tests/issue-3519-ir-outcomes.test.ts`'s `terminal()` helper now returns what
its name always claimed — terminal-unit rows — and a companion `nonExecutable()`
accessor plus one explicit test state the other half of the partition, so the
file records the new rows rather than filtering them away. `issue-1231`'s
`normalizeOutcome` stopped collapsing every non-`emitted` row into
`"unsupported"`: leaving that in place would have reproduced, inside a test's
own projection, exactly the untruth this slice removes from the ledger.
`issue-3520` and `issue-3525` gained the row in their exact projections and an
explicit terminal/non-executable partition respectively — in both cases keeping
the assertion exact rather than loosening a count.

## 2026-09-01 gap-3 implementation plan — WASI prepared module-init adapter

Grounded on `origin/main` `c62b9bc41d`. Slice claim: `#3523:gap3`
(`ttraenkler/fable-ir-takeover`, branch `claude/docs-r4-gap3-plan` for this
plan; the implementation branch claims separately). Three probe lanes
(structural / measured census / test surface) ran against that commit; every
line-number below is from them.

Gap 3 is now the **only remaining direct-body/legacy-body producer in the
12-cell census**: since gap 1a and the scalar-assignment slice landed, every
non-WASI cell measures `direct 0 · legacy 0 · IR 1`, while WASI measures
`direct 2 · legacy 1 · IR 1` for the call-bearing shape and
`direct 1 · legacy 1 · IR 1` for call-free shapes (gap 1a applies to WASI).
The WASI terminal row is `emitted@patch` — the success signature of this slice
is `legacyBodyEmitted` dropping to `false` and pass1 hitting 0, **not** a kind
change.

### Measured facts (census probe, reproducible)

Harness: `JS2WASM_COMPILE_PROFILE=1` + `refreshCompileProfileConfig()` /
`resetCompileProfile()` (`src/compile-profile.ts:12-17`), pass counters summed
from profile rows `module-init-pass1` (`src/codegen/declarations.ts:5988`) /
`module-init-pass2` (`declarations.ts:6186`, gate `:6176-6181`); outcome rows
via `compile(..., { trackIrOutcomes: true })`. Script + raw output preserved in
the planning session's scratchpad (`census-3523.mts`, `census-out.json`,
`wat-b-wasi.wat`).

| Shape | host-start | host-deferred | standalone | wasi |
| --- | --- | --- | --- | --- |
| (a) `const memo = new Map()` + export | 0·0·1 | 0·0·1 | 0·0·1 | **2·1·1** (p1=1,p2=1) |
| (b) `let v = 7` + export | 0·0·1 | 0·0·1 | 0·0·1 | **1·1·1** (p1=1,p2=0) |
| (c) `let total = 0; total = total + 1;` + export | 0·0·1 | 0·0·1 | 0·0·1 | **1·1·1** |

(cells are `direct·legacy·IR`; sizes and full WAT recorded in the probe
artifacts. WASI raw/gzip: a 52,010/31,377 · b 49,230/29,551 · c 49,256/29,563.)

The two corrections vs the 2026-08 table: gap 1a **does** apply to WASI
(call-free shapes skip pass 2), and shape (c) is IR-owned on all non-WASI lanes
(the selector admits a trailing run of exact scalar assignments,
`src/codegen/index.ts:4260-4299`).

### Why WASI is rejected today, and what the guard actually is

- **Rejection sites**: `preparedExactLexicalModuleInit`
  (`src/codegen/index.ts:4182-4310`) — `ctx.wasi ||` at `:4201` in the refusal
  disjunction `:4199-4213`; `exactInvocationLane` (`:4189-4198`) has exactly
  two lanes (host `wasm-start|deferred-export`; standalone native-first) and no
  wasi lane; the bottom re-check `:4307-4309` and the evidence type at `:4014`
  both restrict `invocationKind` to `"wasm-start" | "deferred-export"`. The
  multi-source (M2) route independently rejects at
  `src/codegen/multi-prepared-module-init.ts:135` (`rejectBeforeReservation`).
- **The guard** (`applyModuleInitGuard`, `index.ts:6861-6895`; sole caller
  `:6921-6923` inside `addWasiStartExport` under `if (ctx.wasi)`, post-emission
  in both pipelines — single `:6479-6481`, multi `:11084-11087`): (1) mints a
  fresh `(mut i32)` `__init_done` global via `nextModuleGlobalIdx` **at
  guard-application time** and prepends
  `global.get $done / if(return) / i32.const 1 / global.set $done` to
  `__module_init`; (2) prepends `call __module_init` to **every exported
  function** except the init itself (the "any exported entry runs init first"
  semantics the test262 standalone harness relies on, #1789 comment
  `:6904-6914`). `_start` target selection (`:6944-6992`: exported no-arg
  no-result `main`, else the init handle) happens **after** the guard so a user
  `main` carries the call prefix; `observeWasiStartAdapter` records the adapter
  by object identity (`:7064`), authenticated later by
  `assertGraphGlobalInvocationPolicy` case `"wasi-start-export"`
  (`src/codegen/program-abi-module-init-planning.ts:646-708`) from
  `program-abi-finalization.ts:44`.
- **Why a sealed Prepared body can't take that splice**: the multi pipeline
  seals body identity at preparation-snapshot time and
  `assertPreparedModuleInitCurrent` (`multi-prepared-program.ts:1137-1156`)
  fails on any body reassignment; `add-wasi-start-export` (`index.ts:11084`)
  runs **before** `finalize-multi-prepared-module-init-startup`
  (`index.ts:11115`), so an unmodified guard splice breaks the seal check by
  construction. On the single-file route the invariant-7 reconciliation
  (`declarations.ts:6310-6337`) is gated `skipModuleInitBody && !ctx.wasi`, so
  a wasi admission with no third arm ships with **zero** adapter
  reconciliation.
- **The IR-patch constraint**: `src/ir/integration.ts:4444-4459` withdraws the
  IR module-init patch if `bodyContainsReturnClassOp` (`:4776-4789`) finds any
  non-trailing return — later passes append epilogues (#3168). The guard's
  early-`return` form therefore **cannot be planted at IR-emission time**
  as-is.
- **Existing precedent for mode-conditional prologues on a Prepared body** —
  all inside the sanctioned mutation window `finalizeMultiPreparedModuleInitStartup`
  (`index.ts:6848-6859`), all host-only today: `finalizeInModuleInitFlag`
  (`:6803-6846`, wraps `flag=1 … body … flag=0`),
  `emitInitMarshalHelperRegistration` (`init-marshal-helpers.ts:100-135`),
  `emitInitClassDispatchRegistration` (`init-class-dispatch-helpers.ts:209+`).
- **Invocation policy already speaks wasi**: `IrModuleInitInvocationKind`
  includes `"wasi-start-export"` (`src/ir/module-init-plan.ts:10`), chosen by
  `invocationPolicy()` for `target === "wasi"` (`:188-201`), planned into
  `plan.invocation` for every WASI compile today (pinned by
  `tests/issue-3523-ir-module-init-compile-once.test.ts:146`). The ctx-derived
  twin is `moduleInitInvocationPolicy` (`program-abi-module-init-planning.ts:23-28`).
  The `wasi-start-export` authentication case never runs against a Prepared
  unit today because `graphGlobalPass` is unset when a prepared exact unit owns
  the init (`:439-456`).

### Contract

1. **The guard becomes invocation-policy-driven, not a post-hoc splice.** For
   a Prepared module-init whose `plan.invocation.kind === "wasi-start-export"`:
   the `__init_done` global is reserved at preallocation time (alongside
   `preallocateModuleInitCallable`, `declarations.ts:4990-4994` region) so it
   exists before body emission, and the guard prologue is planted **before the
   seal**, by one of exactly two sanctioned forms — probe P1 decides which:
   - (i) *wrapping-if form* at prepared-body construction:
     `global.get $done / i32.eqz / if (then: done=1 … body …)` — no
     return-class op, passes the `:4776` scan, inside the body at snapshot
     time; or
   - (ii) *early-return form* applied inside the sanctioned mutation window
     (multi: a new step in `finalizeMultiPreparedModuleInitStartup` before
     `finalizePreparedModuleInitStartup`, exactly like `finalizeInModuleInitFlag`;
     single: the `skipModuleInitBody` wiring block), which requires resolving
     the `:11084` vs `:11115` ordering hazard explicitly.
2. **`applyModuleInitGuard` becomes prepared-aware and fails closed.** When
   the init is prepared-owned it must NOT reassign the init body; it
   authenticates that the guard is already present (a recorded receipt or a
   structural check, not trust) and still performs the exported-function
   `call __module_init` prepends and `_start` construction, whose ordering
   contract (`guard before _start target selection`, `:6917-6923`; placement
   before dead-import elimination, `const-box-hoist.ts:150-154`) is unchanged.
   A prepared wasi init with no guard is an `IrInvariantError`, never a silent
   unguarded binary.
3. **Invariant 7 grows its third arm.** The single-file reconciliation drops
   its `!ctx.wasi` gate and gains a `wasi-start-export` arm (expects: no start
   section, no compiler `__module_init` export alias, exactly one
   authenticated `_start` adapter); the multi twin
   (`finalizePreparedModuleInitStartup`, `multi-prepared-program.ts:1159-1209`,
   `exportModuleInit = defer && !wasi` at `:1179`) gains the same arm. The
   `JS2WASM_TEST_MODULE_INIT_DOUBLE_ADAPTER` seam extends to the wasi arm
   (install a start-section adapter the policy did not choose) — without this
   the new reconciliation is vacuous by the project's own standard.
4. **Prepared authentication runs.** The `wasi-start-export` authentication
   shape (`program-abi-module-init-planning.ts:646-708`) — no start section, no
   alias, one `_start` adapter whose first call reaches the target exactly
   once, user-`main` first-call rule — must execute against the Prepared unit
   (either by pointing the existing assert at the prepared callable when
   `graphGlobalPass` is unset, or a prepared twin with identical checks).
5. **Selector admission is the LAST edit.** Third lane in
   `exactInvocationLane` (wasi: `nativeStrings && ctx.wasi` with
   `plan.invocation.target === "wasi"` and `kind === "wasi-start-export"`),
   drop `ctx.wasi` from `:4201`, widen the evidence type at `:4014` and the
   bottom check `:4307-4309`. **Do not add a field to `plan.invocation`** —
   the whole-shape `toEqual` pin at `compile-once.test.ts:104` stays intact;
   the adapter discriminator is derivable from `kind`.
6. **Multi-source WASI stays rejected** (`multi-prepared-module-init.ts:135`
   unchanged) — M2 wasi admission is a follow-up slice, out of scope here.

### Ordered work (behavior pin FIRST)

1. **Commit 1 — the missing behavior pin, on today's overlay route.** The test
   probe found NO idempotency/direct-export behavior pin for any shape this
   slice admits (existing pins — `issue-1789:41-60`, `issue-1411:92-109`,
   `issue-4376:906` — all use shapes the selector keeps rejecting). Add one
   (new `tests/issue-3523-wasi-prepared-module-init.test.ts`): shape (b)/(c)
   under `target: "wasi"`, instantiated with empty imports — (α) calling an
   export without `_start` sees initialized state; (β) `_start()` then export
   → init exactly once; (γ) two distinct exports → once (observable counter,
   the `issue-1789` pattern). Must be green BEFORE the mechanism moves, so the
   relocation is measured against a pin rather than self-certifying.
2. **Commit 2 — guard machinery + reconciliation third arm + seam extension +
   prepared authentication** (contract items 1-4). Unreachable until the
   selector flips; the same PR carries both.
3. **Commit 3 — selector admission + test flips**:
   - `compile-once.test.ts:641` (WASI direct-body-poison arm) moves from the
     near-miss control list to the positive green-under-poison side;
   - wasi lanes join the positive suites at `:509` ("routes all four"), `:592`
     ("never reaches the direct emitter"), `:648` (double-adapter fail);
   - `issue-4376` (Unsupported shape, legacy guard) and `issue-1411`
     (plain-literal assignment, not admitted grammar) must stay green
     UNTOUCHED — they pin the legacy lane this slice does not remove;
   - `issue-3520:483-487` (wasi publishes zero `__module_init` exports) must
     hold for the prepared adapter too.

### Required pre-implementation probes (answers go in the checkpoint note)

- **P1 — guard form.** Decide (i) vs (ii) by measurement: for (i), verify the
  wrapping-if body passes the `:4776` scan and the seal snapshot, and that
  `finalizeInModuleInitFlag`-style later wraps compose with it; for (ii),
  demonstrate the resolved ordering between `add-wasi-start-export` (`:11084`)
  and the finalize window (`:11115`) — moving a pipeline phase needs its own
  justification. Note: the multi window is currently unreachable for wasi
  (item 6), so for THIS slice the decision only has to be sound on the
  single-file route — state where the single-file seal boundary actually is
  (no `assertPreparedModuleInitCurrent` twin exists there; if nothing asserts,
  say so and keep the guard application inside the same block invariant 7
  runs in).
- **P2 — `tests/issue-3517-map-module-init.test.ts` is already red on main**
  (5/14: every "keeps the Map module initializer legacy-owned in <lane>" pin,
  `:146-157`, asserts `<module-init>` ∉ `irCompiledFuncs` while the overlay
  IR-patches it). Establish why main CI is green with this file red (excluded
  from the gate? stale baseline?), then either adopt the rewrite in commit 3
  (the wasi row becomes prepared, the others overlay) or file it as its own
  issue — do not silently inherit.
- **P3 — export-prepend interactions.** The exported-function prepends mutate
  functions that may themselves be IR-prepared free functions; today's legacy
  route already does this without tripping any seal (only the module-init body
  is identity-asserted). Confirm that stays true on the new route, and that
  prepend placement still precedes dead-import elimination / late-import
  renumbering (`const-box-hoist.ts:150-154` contract).
- **P4 — outcome-row truthfulness.** After admission the WASI row must be
  `emitted` with `legacyBodyEmitted: false`, `irBodyEmitted: true` via the
  prepared constructor, not the overlay constructor
  (`ir-overlay-outcomes.ts:928-935` / `:297-298`); name the constructor the
  new path actually uses.

### Verification matrix

- **V-A — non-WASI byte neutrality (file-copy A/B, not the test net).** For
  shapes (a)(b)(c) × {host-start, host-deferred, standalone}: compile at base,
  compile with the change, `cmp` binaries — 9/9 byte-identical required. Any
  delta is a defect (this slice touches nothing non-wasi).
- **V-B — WASI census flip.** Shapes (a)(b)(c) under wasi:
  `direct 0 · legacy 0 · IR 1`, pass1=pass2=0, poison seam green
  (`JS2WASM_TEST_POISON_DIRECT_MODULE_INIT_BODY=1` compiles clean where today
  it fails with "injected direct module-init body poison" — measured on all 3
  wasi cells at base). WASI byte sizes will change (guard is now planted
  differently); record before/after raw+gzip in the checkpoint, no neutrality
  requirement.
- **V-C — behavior.** Commit-1 pin green on both routes; the `issue-1789`,
  `issue-1411`, `issue-4376` legacy-lane pins untouched and green;
  `wasmUnchanged`-class runtime checks: `_start` exported, `__module_init`
  NOT exported, `__exn_tag`/`memory` unchanged.
- **V-D — fail-closed reachability.** Double-adapter seam armed under wasi →
  exactly-one-adapter error with empty binary, plus the Unsupported-control
  compile (the seam only arms the Prepared route); guard-absent prepared init
  (test seam or structural mutation) → `IrInvariantError`, per contract 2;
  the four adapter-mutation authentications
  (`issue-3520:657-688` — strip `_start`, retarget first call, duplicate
  `_start`, inject alias) get prepared-route equivalents.
- **V-E — suites.** Full vitest on the touched files + `pnpm run
  check:ir-fallbacks` (module-init buckets must not grow) + equivalence gate
  via CI.

### Out of scope

Multi-source WASI prepared admission (M2; `rejectBeforeReservation` keeps
`ctx.wasi`), gap 1's call-bearing pass-1 retirement for Unsupported shapes,
the rest of gap 2 (statement grammar past exact scalar assignments), gap 5
(class population, R3), and any change to `plan.invocation`'s shape.

## 2026-09-01 gap-3 checkpoint note — probes P1–P4 answered (Opus implementation lane)

Branch `claude/issue-3523-gap3-wasi-prepared`, based on `origin/main` `7bee941d6`
with the plan branch `claude/docs-r4-gap3-plan` merged in. Three commits:
the behavior pin, the guard machinery, the selector admission.

The base census reproduced the plan's measured facts exactly — WASI
`p1=1,p2=1 / 1,0 / 1,0` for shapes (a)(b)(c), every non-WASI cell `0,0` and
prepared-owned. The two byte figures differ from the plan's by 2–6 bytes
(a 52,012 vs 52,010; b 49,236 vs 49,230; c 49,262 vs 49,256), which is the
one commit main advanced by between the two groundings.

### P1 — guard form: (i), the wrapping `if`, planted at prepared-body construction

**Decision: form (i).** Not a close call, and the deciding evidence is a
composition property the plan flagged but did not resolve.

`finalizeInModuleInitFlag` (#2800) wraps the initializer as
`__in_module_init = 1 … body … __in_module_init = 0`. In the single-module
pipeline it runs at `index.ts:6524`, AFTER `add-wasi-start-export` at `:6479`.
An early-`return` guard at the head of the body therefore skips the trailing
`__in_module_init = 0` on every already-initialized entry — the flag stays 1
forever and every delete-aware read misroutes. That is precisely the #3168
merge-group regression class the `bodyContainsReturnClassOp` withdrawal at
`integration.ts:4444-4459` exists to prevent, and it is a latent defect of the
CURRENT legacy WASI splice, not something this slice introduces (it is
unreachable today only because the flag is a no-op unless a gc/host
delete-aware read recorded it). The wrapping `if` composes correctly in both
directions: it adds no return-class op, so the withdrawal scan passes, and
every appended epilogue still executes on the already-initialized path.

Planting site: `compileIrPathFunctions`' `entry.moduleInit` branch, immediately
after the return-class scan — the body the preparation snapshot seals already
contains the guard, so nothing is spliced later. The `__init_done` global is
reserved in `preallocateModuleInitCallable`, which provably precedes body
emission. Gated on the new `plantPreparedWasiModuleInitGuard` option, set only
by the prepared preparation call in `ir-prepared-free-functions.ts`, so the
post-direct overlay — which patches the same unit on the legacy WASI lane —
cannot plant a second guard.

**Where the single-file seal boundary actually is: nowhere.** As the plan
suspected, there is no `assertPreparedModuleInitCurrent` twin on the
single-module route. `sealPreparedComponents` seals ABI components, not body
identity; body identity is asserted only by `MultiPreparedProgramOwner`, and
`finalizeInModuleInitFlag(ctx)` already mutates a prepared module-init body
there today on the host lanes. So "before the seal" is vacuous on this route,
and the guard is authenticated rather than assumed:
`applyModuleInitGuard` checks the three planted instruction objects are the
body's leading triple **by object identity**. `fixupModuleGlobalIndices`
mutates `.index` in place, so identity survives every legitimate late
import-global shift while a body REPLACEMENT does not — which is the property
an index comparison would not have given. Guard application stays in
`addWasiStartExport`, unmoved; no pipeline phase was reordered, so the
`:11084` vs `:11115` hazard the plan raised for form (ii) never arises.

### P2 — `tests/issue-3517-map-module-init.test.ts`: filed, not inherited

Reproduced on this branch: **5 of 14 red**, exactly the pins the plan named
(`keeps the Map module initializer legacy-owned in {native strings, fast,
standalone, WASI, strict no-host}`, all asserting `<module-init>` ∉
`irCompiledFuncs`).

**Why main CI is green with this file red — measured, not inferred.** The only
job that runs `tests/issue-*.test.ts` is `issue-tests` in `ci.yml:713-759`,
and it is (a) **not a required check** — the required six are `cheap gate`,
`quality`, `merge shard reports`, `check for test262 regressions`,
`equivalence-gate`, `cla-check` — and (b) split into a FATAL pinned step and an
ADVISORY `continue-on-error` changed-files step. `node
scripts/select-changed-issue-tests.mjs --pinned` prints exactly ONE file,
`tests/issue-3529-selector-preclaim.test.ts`. So this file runs in no gate at
all unless a PR touches it, and then only advisorily. The job's own header
documents this hole ("a file can be BORN red … with every gate green").

**Not adopted here, and the reason is scope, not convenience.** Four of the
five red lanes (native strings, fast, standalone, strict no-host) have nothing
to do with WASI and are red because the overlay IR-patches the Map initializer
in lanes this slice does not touch. This slice changes exactly one of the five
— WASI, from overlay-patched to prepared — so adopting the rewrite would mean
re-authoring four assertions whose correct new shape is decided by a different
question (whether the `#3517` pins should track ownership at all, now that
`<module-init>` ∈ `irCompiledFuncs` is the norm rather than the exception).
That belongs in its own issue with its own evidence. **Left to file:** the
implementation lane holds only the `3523:gap3` slice claim and does not
allocate issue ids, so this is handed back to the planning lane as a named
follow-up rather than silently inherited.

### P3 — export prepends: unchanged, and confirmed on the new route

The exported-function `call __module_init` prepends and `_start` target
selection are byte-for-byte the same code on both routes; only the
init-body half of `applyModuleInitGuard` branched.

- **They still land on IR-prepared exports.** For shape (c) under WASI the
  exported `read` is itself prepared (`irCompiledFuncs = ['read',
  '<module-init>']`, row `read` = `emitted / legacy=false / ir=true /
  directBodyEmissions=0 / irBodyEmissions=1 / preparedComponentId` present),
  and the α pin — a direct export call with no `_start` returning the
  initialized value — is only satisfiable through that prepend. No seal
  objects: only the module-init body is identity-asserted anywhere.
- **Placement still precedes dead-import elimination.** `addWasiStartExport`
  remains at `index.ts:6479`, `eliminateDeadLayoutAndPlanProgramAbi` at
  `:6592`; nothing moved, so the `const-box-hoist.ts:150-154` contract holds
  unchanged.

### P4 — outcome-row truthfulness: prepared, with the component id

After admission the WASI module-init row is
`kind: "emitted" · stage: "patch" · legacyBodyEmitted: false ·
irBodyEmitted: true`, carrying

```
prepared-component:ir-unit:v1:ir-source%3Av1%3A…%3Aentry%3At.ts:root:module-init:…
  +ir-unit:v1:ir-source%3Av1%3A…%3Aentry%3At.ts:root:top-level-function:…
```

**The constructor.** Prepared and overlay rows are built by the same arm —
`evidence?.kind === "patched"` in `buildIrOverlayOutcomes`
(`src/codegen/ir-overlay-outcomes.ts:928-935`). What separates them is
`evidence.preparedComponentId`, which is minted only by the
`sealPreparedComponents` closure and is therefore ABSENT on the overlay route.
Before this slice the WASI row had no `preparedComponentId` and
`legacyBodyEmitted: true`; it now has one and `false`. `legacyBodyEmitted`
comes from `:866-867` and is false because the module-init unit is in
`skippedBodyUnitIds`. So the row is prepared-constructed in the only sense the
ledger can express, and the census denominator moves for a real reason.

### Divergence from the plan: `strictNoHostImports` also refuses

Contract 5 said to drop `ctx.wasi` at `index.ts:4201`. Doing only that admits
**nothing**: `strictEnvImportGate` is `input.strictNoHostImports ?? target ===
"wasi"` (`src/target-profile.ts:80`), so `ctx.strictNoHostImports` is
unconditionally true under WASI and refuses the lane by itself. Measured
directly — with `ctx.wasi` dropped, the selector still reached the refusal with
`strict=true, lane=true, target=wasi, kind=wasi-start-export`.

Narrowed to `(ctx.strictNoHostImports && !ctx.wasi)`, which keeps refusing the
case the clause was written for: an **explicit** `--no-host-imports` gc/host
build, a distinct regime this slice's invocation policies do not describe.
`issue-3517`'s "strict no-host" lane still observes the legacy route.

### Verification results

| Check | Result |
| --- | --- |
| **V-A** non-WASI byte neutrality, file-copy A/B + `cmp` | **9/9 IDENTICAL** — (a)(b)(c) × {host-start, host-deferred, standalone}. Re-run after the last production edit, still 9/9. |
| **V-B** WASI census flip | all three cells `direct 0 · legacy 0 · IR 1`, `pass1 = pass2 = 0`. Poison seam `JS2WASM_TEST_POISON_DIRECT_MODULE_INIT_BODY=1`: **RED at base on all 3** ("injected direct module-init body poison"), **GREEN after on all 3**. |
| **V-B** WASI sizes (raw / gzip -9) | a 52,012→**51,365** / 30,963→**30,623** · b 49,236→**49,162** / 29,545→**29,512** · c 49,262→**49,176** / 29,555→**29,516**. Smaller: one reserved global replaces a late-minted one and the wrapping `if` replaces the four-instruction early-return prologue. |
| **V-C** behavior | Commit-1 pin green on both routes (7 tests, unchanged across the relocation). `issue-1789`, `issue-1411`, `issue-4376` legacy-lane pins untouched and green. `_start` exported, `__module_init` never exported, no wasm `start` section. |
| **V-D** fail-closed | Double-adapter seam under WASI → compile fails, empty binary, Unsupported control still compiles. Four adapter mutations get single-source **prepared** equivalents (strip `_start` → "found 0"; duplicate → "found 2"; retarget the adapter's real first `call` → "does not retain its exact selected entry call path"; inject a compiler alias → "must not publish a compiler `__module_init` alias"), each with a positive control. Guard-strip seam → `IrInvariantError` "lost its exact planted idempotence guard", empty binary. |
| **V-E** suites | `check:ir-fallbacks` OK, no module-init bucket growth. All five ratchet gates green. |

**One honest negative.** `tests/issue-4376-module-init-chunking.test.ts >
preserves TDZ ordering for const writes and updates` timed out (35 s ceiling)
in a parallel run on this container. A/B'd in isolation, three runs each: base
30.1 / 27.7 / 30.0 s, after 31.1 / 29.2 / 28.7 s — overlapping ranges. The test
simply sits at ~29 s against a 35 s ceiling on a 4-core box; it is
pre-existing marginal fragility, not a regression from this slice, and the
9/9 byte identity independently rules out a codegen change on that lane.

### Growth allowance

`multi-prepared-program.ts` (+14) and `ir-prepared-free-functions.ts` (+9) are
added to `loc-budget-allow` with the dated rationale in the frontmatter: the
first carries invariant 7's third arm for M2, the second the one option that
scopes guard planting to the prepared preparation call. Both are
reconciliation/routing at the site that owns the prepared module-init
transaction. `scripts/*-baseline.json` untouched.

## 2026-09-01 gap-2b implementation plan — retire the scalar-statement overlay remainder

Grounded on `origin/main` `0d9bfedeea`. Slice claim: `#3523:gap2b`
(`ttraenkler/fable-ir-takeover`). Three probe lanes (selector grammar /
measured shape matrix + corpus frequency / IR-side expressiveness) ran
against that commit, including a file-copy A/B of the candidate edit. Every
line number below is theirs.

### What gap 2 still is, measured

A 15-shape × 4-lane matrix (host-start, host-deferred, standalone, wasi; each
shape with an `export function f()` reader; harness = the
`issue-3523-module-init-single-pass` pass-counter method) shows the gap-2
remainder is **exactly three overlay cells**, identical on all four lanes:

| shape | cell today | why |
| --- | --- | --- |
| s8 `let n = 0; n++;` | `1·1·1` overlay (p1=1,p2=0) | `isPreparedExactScalarModuleAssignment` requires `BinaryExpression` (`index.ts:4129`) |
| s9 `let n = 0; n += 2;` | `1·1·1` overlay | requires `EqualsToken` (`:4132`) |
| s12 `let s = 0; for (…) { s = s + i }` | `1·1·1` overlay | no statement-subtree arm |

For s8/s9 the selector already claims the unit (`reason: null`, arms
`select.ts:5125-5135` / `:5100-5118`), the semantic plan is byte-for-byte the
landed `total = total + 1` shape (1 binding `let:mut:tdz`, evaluations
`variable-initializer[1]`, `statement[0]`, gaps 0, liveSeeds 0), and the IR
body is what already runs under the overlay. **The refusal is entirely inside
`isPreparedExactScalarModuleAssignment` (`src/codegen/index.ts:4120-4184`).**

Everything else in the matrix is NOT a prepared-route question: s1–s5
(string/object/array/template/arrow initializers) are refused by the storage
resolver at `select.ts:5658-5665` (`vardecl-module-storage-unrepresentable`,
a value-representation gap); s6 `var` at `:5584-5586`; s7 `export const` at
`:5587`; s11 `if (a)` at `:6802-6803` (numeric ToBoolean); s10/s13/s14 are
call-bearing (gap 1, `2·1·x`). Every call-free non-admitted shape is already
single-pass (gap 1a holds on all lanes).

**Corpus weight is ~zero**: no module-level `++`/`+=`/`for`/`if` anywhere in
playground/fixtures; in test262 (43,934 runnable files) 98.5 % of module-inits
are call-bearing and the `++`-style shapes appear in <10 files. Gap 2b is an
ownership-cleanliness slice that closes the scalar family; the
conformance-visible R4 item after it is **gap 1** (call-bearing pass-1
retirement), then the selector's `var` gate and storage representability
(#2949-shaped, not prepared-route work).

### The A/B that already ran (probe, throwaway edit, base restored + cmp-verified)

Widening only the head of `isPreparedExactScalarModuleAssignment`
(`:4129-4171`) so `targetIdent`/`readIdent` also come from postfix/prefix
`++`/`--` on an identifier, `id (+=|-=|*=) NumericLiteral`, and
`id = id (+|-|*) NumericLiteral` — leaving the evaluation match
(`:4021-4047`), the oracle same-declaration check (`:4156-4171`) and the
admitted-`let` check (`:4173-4183`) untouched:

| shape | base (4 lanes) | candidate (4 lanes) | runtime |
| --- | --- | --- | --- |
| s8 `n++` | overlay | **`0·0·1` prepared** | 1 ✓ |
| s9 `n += 2` | overlay | **`0·0·1` prepared** | 2 ✓ |
| `let n = 5; n -= 2; n *= 3;` | overlay | **prepared** | 9 ✓ |
| `let n = 5; n = n - 2; n = n * 3;` | overlay | **prepared** | 9 ✓ |
| `let n = 0; n++; let k = 4; k--;` | overlay | overlay (unchanged) | 13 ✓ |
| s12 `for` loop | overlay | overlay (unchanged) | 3 ✓ |
| s15 / landed control | prepared | prepared | ✓ |

The interleaved case stays overlay only because of `sawAssignment`
(`:4280`, `:4286`, `:4307`) — an order-only rule: bindings are consumed by
`declarationOrdinal`, evaluations by population ordinal (`:4265-4275`), so
nothing in the plan requires declarations-first.

### Contract

1. **Sub-A — operator family.** `isPreparedExactScalarModuleAssignment`
   admits, on an earlier-admitted mutable `let` target with numeric (`f64`)
   storage: `id++`, `++id`, `id--`, `--id`; `id (+= | -= | *= | /=)
   NumericLiteral`; `id = id (+ | - | * | /) NumericLiteral` (target and read
   identifier must resolve to the SAME declaration via
   `ctx.oracle.declarationsOf`, as today at `:4156-4171`); `id = NumericLiteral`.
   The evaluation stays `kind:"statement"` at the exact ordinal with
   `bindingIds: []`. NOT admitted (they are the new near-misses): `**=`,
   `%=`, bitwise/shift ops, `id = 1 + id` (operand order), parenthesized RHS,
   string RHS, `const` target, boolean `!flag` (i32 storage — `++` on a
   boolean-branded binding must stay refused, from-ast.ts:11819-11823), any
   RHS identifier other than the target.
2. **Sub-B — drop `sawAssignment`.** Remove the declaration-after-assignment
   refusal (`:4280`, `:4286`, `:4307`); zip stays by `declarationOrdinal`
   (declarations) and population ordinal (evaluations); F1 at `:4322-4328`
   still requires every planned binding consumed.
3. Both edits are confined to `src/codegen/index.ts`. No change to the plan
   builder, the overlay, `applyModuleInitGuard`, invocation wiring, the
   `:4100-4117` reachability scan (it must still run on every admitted
   initializer), TDZ-elision gating (`wasm-start` only, `:4668`), or
   `plan.invocation`'s shape (`toEqual` pin at compile-once.test.ts:104).
4. Every rejection stays a silent `return undefined` before any mutation.

### Pins that move (all in `tests/issue-3523-ir-module-init-compile-once.test.ts`)

- Near-miss controls at `:620-662` that become **positives**: `total += 1`,
  `total++`, `total = total - 1`, the WASI compound (`:655-657`), and the two
  `sawAssignment` controls (`total = total + 1; let total = 0` stays a
  near-miss for the OTHER reason it pins — target not admitted — but
  `let total=0; total=total+1; let later=2` at `:640` becomes a positive).
- The host-deferred **overlay control** `let total = 0; total += 1;` at
  `:677-679` (the `legacyBodyEmitted:true` control for the double-adapter
  seam) flips to prepared — replace it with a shape that stays overlay
  (s12's `for` loop, or `total **= 2`) so the seam test keeps a real control.
- New near-misses added per contract item 1, each proven RED under the poison
  seam (`JSW…POISON_DIRECT_MODULE_INIT_BODY=1`) while the admitted shapes go
  GREEN — the existing "fails closed for every near-miss grammar" anatomy.
- The "is structural rather than allowlisted" positives (`:546-584`) gain the
  interleaved-declaration case.

### Required pre-implementation probes (answers go in the checkpoint note)

- **P1 — `/` and `id = NumericLiteral`**: the probe A/B covered `+ - *` and
  `++/--/+=/-=/*=`; before admitting `/=`, `= id / num` and `= num`, A/B each
  on all four lanes with a runtime value only that statement can produce
  (e.g. `let n = 8; n /= 2;` → 4). Refuse any operator whose A/B is not
  `0·0·1` with the right value.
- **P2 — storage kind guard**: confirm the admitted target's storage is `f64`
  (or dynamic) for `++/--` and the arithmetic ops — cite the resolver arm
  (`from-ast.ts:11819-11823` / `select.ts:5125-5135`) and add the boolean-`let`
  near-miss.
- **P3 — `for`-loop non-admission**: confirm s12 stays overlay under the final
  predicate (it must — statement-subtree admission is a later slice) and use
  it as the replacement overlay control.
- **P4 — ledger defect, adjacent**: the census found
  `tests/fixtures/extern-demo.ts` (`declare namespace` = `ModuleDeclaration`)
  counted in `collectModuleInitPopulation` (`src/ir/module-init.ts:11-24`) and
  selector-rejected with `legacyBodyEmitted:true` while NO direct pass ran —
  a truthfulness defect adjacent to gap 4. Do NOT fix here; confirm it with
  one compile and file it as its own issue (`claim-issue.mjs --allocate`).

### Verification matrix

- **V-A byte neutrality of already-admitted shapes** (file-copy A/B, `cmp`):
  census shapes (a) `const memo = new Map()`, (b) `let v = 7`, (c)
  `let total = 0; total = total + 1;` × 4 lanes — 12/12 byte-identical
  (predicate-only change). Any delta is a defect.
- **V-B newly admitted shapes**: s8, s9, the four A/B multi-statement
  variants, plus the P1 shapes — `0·0·1` on all four lanes, pass1=pass2=0,
  `preparedComponentId` present, poison seam GREEN, double-adapter seam FATAL,
  runtime values correct, and on the deferred lanes: throw before
  `__module_init`, correct read after.
- **V-C non-vacuity by revert**: restore only sub-A → exactly the operator
  positives fail; restore only sub-B → exactly the interleaved positive fails;
  the near-miss suite stays green in both.
- **V-D census diff**: `pnpm run check:ir-fallbacks` output diffed (no bucket
  moves — the corpus has none of these shapes); `check:ir-only` baseline
  ceilings unchanged.
- **V-E** the five ratchet gates chained before commit; affected suites
  (`issue-3523-*`, `issue-4376`, `issue-1411`, `issue-1789`) green.

### Out of scope (each has its own next step)

Statement-subtree admission (`for`/`while`/`if`/`block`/`try` bodies — a
recursive predicate, after this lands); multi-declarator statements;
`export const/let` (`vardecl-modifier`, selector-side); string/object/array
storage kinds (`IrModuleBindingValueKind` — a value-representation slice, NOT
byte-neutral across the free-function population, needs the 25-file corpus
A/B); arrow/function initializers (gap 1's pass-1 purpose); `var`
(`initialization:"undefined-at-instantiation"` policy); call statements and
call initializers (**gap 1 — the next R4 slice after this one**, with the
13th census cell `function h(){…} h(); export function read()` the IR probe
asked for); gap 5 (R3).

## 2026-09-01 gap-2b checkpoint note — probes P1–P4 answered (Opus implementation lane)

Branch `claude/issue-3523-gap2b-scalar-statements`, based on `origin/main`
`d153a08826` with the plan branch `claude/docs-r4-gap2b-plan` merged in.
Two edits, both confined to `src/codegen/index.ts` as the contract requires.

The base census reproduced the plan's measured facts exactly on a five-lane
grid (the plan's four plus `standalone-deferred`): the landed
`total = total + 1` control is `0·0·1` prepared everywhere, and **every**
shape this slice targets — s8/s9, all four `++`/`--` forms, `-= *= /=`,
`= id - num`, `= id * num`, `= id / num`, `= num`, both multi-statement
variants and both interleaved-declaration cases — read `1·0·0` overlay with a
correct runtime value. Byte figures below are from this grounding, not
inherited.

### P1 — `/=`, `= id / num` and `= num`: all three admitted, A/B'd on five lanes

The plan's A/B covered `+ - *` and `++/--/+=/-=/*=` only, so these three ran
their own base/candidate pair before being admitted. All three clear the bar:

| shape | base (5 lanes) | candidate (5 lanes) | runtime |
| --- | --- | --- | --- |
| `let n = 8; n /= 2;` | `1·0·0` overlay | **`0·0·1` prepared** | 4 ✓ |
| `let n = 8; n = n / 2;` | `1·0·0` overlay | **`0·0·1` prepared** | 4 ✓ |
| `let n = 0; n = 7;` | `1·0·0` overlay | **`0·0·1` prepared** | 7 ✓ |

Each value is one only the statement can produce — initializer-only execution
returns 8, 8 and 0 — so a silently dropped statement fails on the number. No
operator was refused: nothing in the contract's admit list failed its A/B.

### P2 — storage kind: guarded positively on `number`, and the guard narrows nothing

The plan asked for confirmation that the target's storage is `f64` or dynamic.
The measurement changed the shape of the answer: **the dynamic case is already
refused upstream.** `let x: any = 0; x = x + 1;` reads `1·0·0` overlay on all
five lanes on BASE — the selector's storage resolver never offers it — so a
guard admitting only `number` narrows nothing that is admitted today. That is
what V-A's 15/15 byte-identity then confirms independently.

So the predicate carries a positive guard, `ctx.oracle.staticJsTypeOf(target)
=== "number"`, rather than a boolean-shaped denial. It is routed through the
oracle, not the raw checker, so the oracle-ratchet gate stays green. The arm it
anticipates is `from-ast.ts`'s `!slotValType || slotValType.kind !== "f64"`
demotion (`compound-assign-unsupported`): deciding it in the predicate keeps
the refusal a silent non-admission instead of a late demotion.

The boolean near-miss is measured, not assumed: `let flag = true; flag++;` is
`1·0·0` overlay on base AND candidate, and is now a poison-proven control.

### P3 — the `for` loop stays overlay, and is now the seam's control

`let s = 0; for (let i = 0; i < 3; i++) { s = s + i; }` is `1·0·0` overlay on
all five lanes under the final predicate, as required — statement-subtree
admission is a later slice. It therefore replaces `let total = 0; total += 1;`
as the `legacyBodyEmitted: true` control in the double-adapter seam test. That
substitution is load-bearing: `total += 1` is admitted by this slice, so
leaving it in place would have left the seam test asserting `true` against a
shape that is now prepared, and the control would have silently stopped
controlling.

### P4 — the `declare namespace` ledger defect: confirmed, filed as #5273

Confirmed with one compile of `tests/fixtures/extern-demo.ts`:

```
population size: 1
  kind: ModuleDeclaration "declare namespace Host {\n  class Box {\n "
direct passes: pass1 = 0  pass2 = 0
module-init outcome: {"kind":"unsupported","legacyBodyEmitted":true,"irBodyEmitted":false}
```

`collectModuleInitPopulation` (`src/ir/module-init.ts:9-27`) skips every
type-only statement kind except `ts.ModuleDeclaration`, so a `declare
namespace` is counted as runtime work; the row then claims a legacy body while
`pass1 = pass2 = 0` proves none was emitted. Not fixed here (different file,
different mechanism, and it moves a module out of the claimable bucket, so it
needs its own census diff). Filed as
**[#5273](https://js2wasm.loopdive.com/dashboard/issue.html?slug=5273-module-init-ledger-type-only-declarations)**.

**Reservation caveat, stated because it affects the id's trustworthiness:**
`gh` is not installed in this implementation container, so
`claim-issue.mjs --allocate` refused (exit 6, open-PR scan degraded) and the id
was reserved with the sanctioned `--allow-unscanned`. #5273 is verified on
`origin/issue-assignments` but **not** against in-flight PRs
(`pr_scan=degraded`); re-check for a collision before that file merges.

### Verification

- **V-A byte neutrality — 15/15 `cmp`-identical.** Census shapes (a)
  `const memo = new Map()`, (b) `let v = 7`, (c) `let total = 0; total = total
  + 1;` × five lanes, base-vs-candidate by file copy captured at the FIRST
  edit. Zero differing bytes: host-start 255/168/182, host-deferred
  268/268/282, standalone-start 51287/22642/22656, standalone-deferred
  51300/49097/49111, wasi 51365/49162/49176.
- **V-B — every newly admitted shape is `0·0·1` on all five lanes**, pass1 =
  pass2 = 0, `preparedComponentId` present, correct runtime value, and on the
  deferred lanes it throws before `__module_init` and reads correctly after.
  Pinned by "owns the whole scalar-statement operator family on every lane";
  the poison seam is green for the whole family (the poison test now iterates
  the family, not just `SOURCE`) and the double-adapter seam stays fatal.
- **V-C non-vacuity by revert — both sub-edits are independently
  load-bearing.** Reverting only sub-A: the three operator/family tests fail,
  the near-miss suite and the double-adapter seam stay green. Reverting only
  sub-B: `n++` is still `0·0·1` prepared while
  `let total = 0; total = total + 1; let later = 2;` falls back to `1·0·0`
  overlay on all five lanes — exactly the interleaved positive, nothing else.
- **V-D census diff — no movement.** `pnpm run check:ir-fallbacks` output is
  byte-identical base vs candidate (diff empty; unintended buckets still
  `(none)`), and `check:ir-only` is identical too (`READY`, 41 terminal units,
  38 emitted, 0 legacy body emitted). The corpus contains none of these shapes,
  as the plan measured.
- **V-E** — the five ratchet gates chained green before the commit, and the
  affected suites pass: `issue-3523-*` (4 files, 69 tests), `issue-4376`,
  `issue-1411`, `issue-1789` and the three IR-retirement files (104 tests, 13
  skipped). One note on honesty: `issue-4376-module-init-chunking` timed out
  once at 35 s in a heavily parallel combined run; it passes in isolation and
  on re-run of the same combined command, and the shape it pins
  (`const locked += (effects = 1)`) is refused twice over by the new predicate
  (const target, parenthesized non-literal RHS).

### Two deliberate deviations from the plan's letter

- **The new near-misses and the two heavy family tests needed explicit
  timeouts** (300 s). 16 shapes × 5 lanes is ~80 real compiles per test and the
  file inherits vitest's 35 s default. The alternative — trimming lanes — would
  have weakened exactly the V-B claim the plan asks for.
- **`src/codegen/index.ts` grows 80 lines past its god-file ceiling**, so this
  change-set restates the `loc-budget-allow` grant with its own dated
  rationale below. The contract confines both edits to that file; there is no
  subsystem module to move a prepared-route admission predicate into without
  splitting the ownership the transaction exists to hold.

## 2026-09-01 gap-1b implementation plan — skip pass 2 for closure-free call-bearing module inits

Grounded on `origin/main` `e36225ee65` (includes gap-2b, PR #5435). Slice
claim: `#3523:gap1b` (`ttraenkler/fable-ir-takeover`). Three probe lanes
(mechanism read + two throwaway env seams / 12-shape × 4-lane census + test262
call-shape ranking / three-candidate A/B on shapes, corpus, and a 319-file
test262 compile sample + 89-file runner-faithful runtime sample) ran against
that commit; every line number below is theirs.

### What gap 1 is, measured — and what it is NOT

- **Retiring pass 1 is UNSOUND.** Function bodies compiled between the passes
  deliberately consume pass 1's END integrity state
  (`declarations.ts:5672-5674`: `definedPropertyFlags`, `frozenVars`,
  `sealedVars`, `nonExtensibleVars` snapshot/restore) and its `closureMap`
  discovery (`arrow-phases.ts:1303-1323`). Seam B (compile bodies first, one
  init compile in the pass-2 slot) flipped
  `const o={p:1}; Object.freeze(o); export function read(){ o.p=2; return o.p }`
  from a correct TypeError to a silent write (`read()=2`, all lanes), changed
  error identity on defineProperty-then-write, lost `closureMap`-driven
  `call_ref` codegen (2.7× larger binary on the arrow shape), and produced
  **6/89 host test262 regressions**, all async (`doneprintHandle.js`'s
  `__consolePrintHandle__` compiles from a closure-cast body to a bare `call`
  without pass-1 discovery; `$DONE` inlines it; the runner never sees
  completion). Pass 1 stays.
- **Pass 2's stated reason is vacuous for direct init statements.** The
  `:6180-6182` comment ("so call sites can see the final inlinable-function
  registry") does not hold: with `JS2WASM_IR_INLINE=0` the two-pass
  `__module_init` still emits `call 1` for a call to a small local function —
  all inlining seen is the finalize-time `ir-inline.ts` pass
  (`index.ts:6690-6691`), which runs after both passes over every function;
  IR-claimed callees never enter the registry (`declarations.ts:6052-6058`).
  The registry inliner fires only INSIDE closure bodies compiled during init.
- **Seam A (skip pass 2 unless chunk/async forced) is byte-identical for the
  closure-free family.** 13 closure-free call-bearing shapes (local fn call
  init/stmt, `console.log`, `new Map`+`m.set`, `Object.freeze`, inlinable local
  call, `new` local class, static-block call, string method, `a.push`,
  `parseInt`, legacy `h(a:any)`, `arguments` callee) × 4 lanes: **52/52
  byte-identical** (sole exception: `console.log` on WASI, where the two-pass
  base carries a duplicate dead `(data … "\n")` segment pass 2 re-registers —
  one-pass is smaller, code identical). Corpus 26 files × 2 lanes: 50/52
  identical (the two: closure-bearing). Runtime parity on every shape/lane
  (7 × 4 × IR on/off = 56 pairs) and 8/8 runner-faithful test262 files.
- **Closure-bearing populations differ** (arrow/fn-expr initializer, arrow
  calling a local fn, `var g=function`, closure global reassigned in a fn,
  legacy callee inside an arrow body): pass 2 mints a dead re-lifted
  `$__closure_N` twin and gets registry-inlining inside closure bodies; runtime
  equal, bytes differ. These stay two-pass in this slice.
- **Gap 1 is NOT conformance-visible through pass-count work.** On a 319-file
  test262 sample every module-init population is closure-bearing (the harness's
  `assert.sameValue = function…`, `Test262Error`, `new`), 122–165/319 are
  chunk-forced anyway, and the IR outcome is `body-shape-rejected` 81/81. The
  only route that retires those rows is pass-1 REPLACEMENT, which needs a
  closure-fact inventory ahead of bodies (the facts `registerClosureBindingInfo`
  writes at `arrow-phases.ts:1291-1322`: struct/lifted type idx, arity,
  `needsCallSiteArity`) that R2/#4617 do not carry today. That is the design
  item AFTER this slice, measured against Seam B's failure set
  (`Promise/allSettled/iter-assigned-undefined-reject.js` et al.) — not the
  IR-owned call-bearing candidate, which has zero test262 yield until the
  selector admits harness-shaped populations.

### Contract

1. Replace `moduleInitPopulationIsCallFree`
   (`src/codegen/declarations/module-init-call-free.ts:52-95`) with a
   **pass-2-stability** predicate (rename or sibling — keep the fail-closed,
   no-allowlist, full-subtree shape at `:33-45`): refuse on `ArrowFunction`,
   `FunctionExpression`, `ClassExpression`, `Decorator`, `AwaitExpression`;
   ADMIT `CallExpression`, `NewExpression`, `TaggedTemplateExpression`. Scan
   every `ctx.moduleInitStatements` statement and each `ctx.staticInitExprs`
   entry's `staticBlock ?? initializer`, as today.
2. The pass-2 gate at `declarations.ts:6197-6202` keeps
   `JS2WASM_TEST_FORCE_MODULE_INIT_PASS2 || hasAsyncGraphInit ||
   moduleInitChunkingRequired` and swaps the last disjunct to the new
   predicate. **No other change**: no selector, prepared-route, adapter,
   invocation, TDZ (`:5602`), poison-seam (`:5845`) or WASI
   `__init_done` reservation edit. `0/0` (IR-owned) rows are untouched by
   construction (the gate sits inside the `full`-mode pass-2 block).
3. Fix the `:6180-6182` comment to state the measured truth (registry
   inlining reaches only closure bodies compiled during init; the finalize
   inliner handles direct statements), and record the async-callee completion
   shape (`void run()` on an async callee: pass 2 emits `call Promise_resolve`
   as the try result, pass 1 `ref.null extern / call / drop`; both validate,
   runtime equal — `nm_js2wasm_wasi_p3.ts`) as a KNOWN byte delta on
   closure-bearing populations, which remain two-pass.

### Required pre-implementation probes (answers go in the checkpoint note)

- **P1 — scar-family suites under the seam (NOT yet measured).** The census
  ran the control side of `issue-2965`, `issue-3872`, `issue-4182`,
  `issue-4195`, `issue-4376-module-init-chunking`,
  `issue-3523-ir-module-init-compile-once`,
  `issue-3523-module-init-single-pass`, but the seam-side run was cut by the
  probe deadline. Run all seven with the new predicate BEFORE writing any pin;
  any failure is a STOP-and-diagnose (it names a pass-2 dependency the shape
  matrix missed).
- **P2 — diagnostics parity.** One test262 file (`for-in/cptn-decl-itr.js`)
  showed base e1 vs one-pass e2: pass 1 alone emits a duplicate diagnostic
  that today's `dedupeDiagnosticsFrom(ctx, pass1DiagnosticMark)` (`:6214`)
  collapses only when pass 2 runs. Determine whether the dedupe must also run
  on the one-pass route (it should — the mark is taken at `:5698` regardless)
  and pin error-count parity on that file and on the 319-file sample (expected
  0 divergence — all sampled populations are closure-bearing and keep two
  passes).
- **P3 — the WASI dead data segment.** Confirm the `console.log`-on-WASI delta
  is exactly the duplicate `"\n"` segment (document it; `WebAssembly.validate`
  + runtime parity + identical import surface are the WASI acceptance
  criteria for that shape, not byte identity).
- **P4 — mutation.** Admitting `ArrowFunction` in the predicate must break the
  byte-identity pin on the c21 shape (`h(a:any)` called inside an arrow) —
  proves the closure refusal is load-bearing rather than decorative.

### Verification matrix

- **V-A**: the 13 closure-free call-bearing shapes × {host-start,
  host-deferred, standalone, wasi} → `1/0` (pass1=1, pass2=0), byte-identical
  (`cmp`) vs `JS2WASM_TEST_FORCE_MODULE_INIT_PASS2=1` on gc/host-deferred/
  standalone; WASI per P3. The 6 closure-bearing shapes → `1/1` unchanged. A
  17-statement population → `1/1` (chunk-forced). IR-owned shapes → `0/0`
  unchanged, byte-identical.
- **V-B**: runtime values via instantiation on host/standalone for every
  shape; runner-faithful `runTest262File` on the 89-file host sample —
  pass count 62 → 62, zero status divergence.
- **V-C**: corpus (`website/playground/examples/**`, `examples/**`) host +
  standalone — 50/52 byte-identical, the two closure-bearing rows unchanged
  from base (they stay two-pass).
- **V-D pins that move** (`tests/issue-3523-module-init-single-pass.test.ts`):
  `:236-250` controls `call-in-initializer`, `new-in-initializer`,
  `call-in-static-block`, `tagged-template` → `1/0`
  (`call-in-initializer-arrow-body` stays `1/1`); `:373-384` inline-route pin
  `1/1` → `1/0` with the byte identity vs forced still holding (measured c8).
  Add the P4 mutation pin and the P2 diagnostics-parity pin.
- **V-E**: the five ratchet gates chained; `check:ir-fallbacks` output diffed
  (no bucket moves); the seven scar-family suites green (P1).

### Out of scope (and the honest sequencing after it)

IR-owned call-bearing admission (selector Gate 2 uses an empty claimed set on
the production branch, `select.ts:1046-1053`; the prepared reachability scan
`index.ts:4100-4117` is component-closure for ALL callees, not just closures —
admitting calls needs the real claimed set, `directCalls` plans, grammar arms,
and the import-manifest preflight; zero test262 yield today). Pass-1
replacement (needs the closure pre-lift inventory — the next design item, to be
planned against Seam B's failure set). Multi-source `"discover"`/`"full"` mode
split (`index.ts:10667`). Gap 5 (R3).

## 2026-09-01 gap-1b checkpoint note — probes P1–P4 answered (Opus implementation lane)

Branch `claude/issue-3523-gap1b-pass2-skip`, based on `origin/main` `813b828b6e`
with the plan branch `claude/docs-r4-gap1b-plan` merged in. Three files:
`src/codegen/declarations/module-init-call-free.ts` renamed to
`module-init-pass2-stable.ts` (predicate widened), `src/codegen/declarations.ts`
(+11, all comment) and `tests/issue-3523-module-init-single-pass.test.ts`
(9 cases → 15). No selector, prepared-route, adapter, invocation, TDZ, poison or
WASI-guard edit, as the contract requires.

Every figure below is from a run in this worktree, base captured by file copy at
the first edit (`.tmp/base-declarations.ts`,
`.tmp/base-module-init-call-free.ts`) and flipped with a two-line `flip.sh`,
never `git stash`.

### The one deviation that changes the contract: the predicate is a UNION, not a closure refusal

The contract says "refuse on `ArrowFunction`, `FunctionExpression`,
`ClassExpression`, `Decorator`, `AwaitExpression`; ADMIT `CallExpression`,
`NewExpression`, `TaggedTemplateExpression`". Implemented literally, that
**regresses gap-1a**: `const f = (x: number): number => x * 2;` is
closure-bearing and call-FREE, and the base census measured it at **`1/0` on all
four lanes** — gap-1a already put it on the one-pass route, and `GATED_SHAPES`
pins it there (`tests/issue-3523-module-init-single-pass.test.ts:143-165`,
asserted at `:197-216`). A pure closure refusal sends it back to `1/1`. V-D does
not list that pin as moving, so the plan's own acceptance criteria require it not
to.

The shipped predicate is therefore the disjunction the two measurements support:

```
pass-2-stable  ⇔  no Decorator/Await anywhere
                  AND NOT (a call AND a closure both appear)
```

- **call-free** (closure or not) — gap-1a's measured half, 50/50 corpus binaries
  byte-identical, already on main;
- **call-bearing, closure-free** — gap-1b's half, measured below;
- **both** — the only refusal, and it is refused for two independent measured
  reasons (byte divergence, P4; duplicate diagnostics, P2).

Stated as one sentence: a second compile can only differ through the
inlinable-function registry (which needs a CALL to consult it) or through
closure re-lifting (which needs a CLOSURE to lift), so a population missing
either ingredient is stable. That is a strictly more faithful reading of the
plan's own measured facts than the node-kind list, and it is why the module and
its predicate were renamed rather than replaced.

### P1 — the seven scar-family suites: six green, the seventh is the pin file itself

Run before any pin was written, with the new predicate:

| suite | result |
| --- | --- |
| `issue-2965` | green |
| `issue-3872` | green (the 5 failures gap-1a saw on `fe3fe11e52` are gone from main) |
| `issue-4182-annexb-global-blockfn` | green |
| `issue-4195-eval-refusal-message-and-dedupe` | green |
| `issue-4376-module-init-chunking` | green |
| `issue-3523-ir-module-init-compile-once` | green |
| `issue-3523-module-init-single-pass` | 5 failures, all pin moves |

**No pass-2 dependency the shape matrix missed.** The five failures are the V-D
moves plus three sub-assertions V-D did not enumerate (they move for the same
reason — a call alone no longer disqualifies): the `static-block-call` arm of
"scans the compile inputs, not the source file", the "earlier source contributes
a call" arm of the multi-source constraint, and the `control` shape of the
diagnostics test. All are re-pinned at their new values, and each kept a genuine
two-pass control by adding the closure ingredient (class-expression method,
`const make = () => mk()`, `const f = () => h()`).

**On the final artifact all seven suites are green (108 tests).** One
load-dependent flake appeared in between and is worth naming because it will
appear again: `issue-4376-module-init-chunking > preserves TDZ ordering for
const writes and updates` times out at vitest's 35 s default when the box is
busy, **identically on the reverted base** in isolation (load average ≈5.5,
another agent active; base run 130.3 s wall, candidate 132.6 s). It passes on a
quiet box. Not caused by, and not touched by, this slice — the same flake the
gap-2b checkpoint recorded.

### P2 — the dedupe does NOT move to the one-pass route, and the reason is now causal

The plan expected `dedupeDiagnosticsFrom(ctx, pass1DiagnosticMark)` to be needed
on the one-pass route because `cptn-decl-itr.js` showed base `e1` vs one-pass
`e2`. Measured with the shipped predicate, that divergence **does not exist**:

- `language/statements/for-in/cptn-decl-itr.js` through
  `assembleOriginalHarness` (runner-faithful: `allowJs`, `sourceMap`,
  `skipSemanticDiagnostics`, `deferTopLevelInit`) reads **`1/1`, one error**,
  same as forced. Its harness population is closure-bearing AND call-bearing, so
  the predicate refuses it and pass 2 still runs.
- **320 runner-faithful test262 files**: 0 error-count mismatches vs forced.
- **10 constructed error-bearing admitted populations** (call + bad destructure,
  static-block call + bad, `new` + bad, `console.log` + bad, two identical bad
  statements, bad inside a `for…of` body, …): 0 mismatches, and no intra-pass
  duplicate at any location.

The plan's observation is nevertheless REAL, and the mutation names its cause:
with closures admitted through the test seam, `cptn-decl-itr.js` goes **`1/0`
and reports the same diagnostic twice** (`errors=2` vs forced `1`). So the
duplicate is produced by pass 1 alone on a **closure-bearing** population — the
class the plan's unconditional Seam A admitted and this contract refuses. Adding
the dedupe to the one-pass route would have been a silent behavior change to
gap-1a's landed route (collapsing pairs that nothing produces) bought against a
hazard the predicate already excludes. It is pinned instead: the test262 parity
case above is exactly what fails if a future widening admits closures.

### P3 — the WASI `console.log` delta is TWO dead segments, not one

The plan called it "the duplicate dead `\n` data segment". Measured, the
two-pass WASI module carries a dead duplicate of **every** segment the call
registers:

```
  (data (i32.const 1024) "\68\69")     <- "hi", live in the one-pass build
  (data (i32.const 1026) "\0a")        <- "\n",  live in the one-pass build
- (data (i32.const 1027) "\68\69")     <- dead duplicate, two-pass only
- (data (i32.const 1029) "\0a")        <- dead duplicate, two-pass only
```

The only other difference is the two segment-address operands (`1027→1024`,
`1029→1026`); the code is otherwise identical. 22 848 → 22 833 bytes, both
validate, identical import surface. Pinned as a segment-count delta of exactly
2 plus "strictly smaller", not as byte identity.

**A second dead-artifact family the plan did not have: the tagged template.**
``tag`abc` `` differs on **all four** lanes (−6 bytes) because pass 2 mints a
second template-object cache global and orphans pass 1's:

```
   (global $__tt_cache_0 (mut (ref null 5)) (ref.null 5))
-  (global $__tt_cache_1 (mut (ref null 5)) (ref.null 5))   <- two-pass only, and the LIVE one there
```

One-pass emits one cache and uses it, so the per-site template identity the cache
exists for is preserved. Pinned with a global-count assertion (1 vs 2).

### P4 — the closure refusal is load-bearing, mutation-proven

Admitting closures (test-only seam
`JS2WASM_TEST_ADMIT_CLOSURES_IN_MODULE_INIT_PASS2_GATE=1`, which only ever
WIDENS admission) breaks byte identity on the c21 shape `h(a: any)` called
inside an arrow, on every lane:

| shape | host-start | host-deferred | standalone | wasi |
| --- | --- | --- | --- | --- |
| `legacy-callee-inside-arrow` mutant vs forced | 4414 / 4412 | 4427 / 4425 | 127 885 / 127 882 | differ at equal length |

The mutation moves 20 further rows (k1–k5 × 4 lanes) from identical to
differing: 13 differing rows under the shipped predicate, **33 under the
mutant**. The seam exists so this is a PIN, not a one-off measurement — the plan
asked for a mutation pin and a test cannot otherwise reach a predicate decision.
That seam is the third deviation from the plan's letter.

### V-A — census, 4 lanes × the full shape matrix

Base reproduced the plan's table exactly before any edit (13 call-bearing shapes
`1/1` on all four lanes; IR-owned `0/0`; gap-1a gated `1/0`).

| family | base | candidate |
| --- | --- | --- |
| 13 closure-free call-bearing × 4 lanes | 52 × `1/1` | **52 × `1/0`** |
| 5 closure+call shapes × 4 lanes | 20 × `1/1` | unchanged |
| call-free arrow initializer × 4 lanes | `1/0` (gap-1a) | unchanged `1/0` |
| 17-statement chunk-forced × 4 lanes | `1/1` | unchanged (`moduleInitChunkingRequired` wins) |
| IR-owned / function-only × 4 lanes | `0/0` | unchanged, byte-identical |

**Byte identity vs `JS2WASM_TEST_FORCE_MODULE_INIT_PASS2=1`: 47/52** on the
call-bearing family. The 5 exceptions are the two dead-artifact families above
(tagged template × 4 lanes, `console.log` on WASI × 1) — every one is the
one-pass build being SMALLER by dropping something dead; all validate, all
import surfaces equal, all runtime values equal. Across the whole 116-row
matrix: 103 identical, 13 differing, of which 8 are the pre-existing gap-1a
arrow-initializer rows (`3757` vs `3786` — pass 2's dead re-lifted closure twin,
already on main and already accepted there).

### V-B — runtime

- **58/58 runtime pairs** (every shape × {host, standalone}, one-pass vs forced)
  return the same value, and each equals the value only the init statement can
  produce.
- **Runner-faithful `runTest262File`, 89 host files**: `pass=80 fail=9` on base,
  `pass=80 fail=9` on candidate, **zero status divergence** (per-file compare).
- **320 runner-faithful test262 compiles**: 320/320 byte-identical vs forced,
  0 error-count mismatches. Route movement base → candidate: **two files** moved
  two-pass → one-pass; 270 stay two-pass (their harness population is
  closure-bearing, exactly as the plan predicted) and 50 have no direct init.
  This slice's test262 yield is zero, as the plan states.
- **Async-callee shapes** (the family most likely to depend on pass 2 seeing a
  compiled body): `void run()`, `const p = run()`, `run().then(…)`, an async call
  in a static block, and a generator call — all runtime-equal on host and
  standalone; all byte-identical except the generator, where the one-pass build
  keeps an inert `(block (result (ref null 8)) …)` wrapper around the same
  `struct.new` (+5 host / +4 standalone bytes, same value).

### V-C — corpus (`website/playground/examples/**`, `examples/**`), host + standalone

52 rows, **50 byte-identical**, 14 rows newly on the one-pass route. The two
differing rows are both `examples/native-messaging/nm_js2wasm_wasi_p3.ts`:

- host: the one-pass build emits `ref.null extern / call Promise_resolve / drop`
  where the two-pass build emits `call Promise_resolve` on the block's result
  (+3 bytes). The try's result is `drop`ped immediately in BOTH builds, so the
  difference is only which value is handed to a discarded `Promise.resolve`.
- standalone: a `drop` ordering swap around a pure `global.get` /
  `extern.convert_any` pair, identical length.

Both validate; the source's whole init population is `void run();`.

**This corrects the plan's contract item 3**, which files this delta under
"closure-bearing populations, which remain two-pass". `void run();` is
call-bearing and closure-FREE, so the predicate ADMITS it — the delta appears on
the new route, not on a refused one. It is inert (dropped values only), but it is
not the category the plan put it in.

### V-D — pins

`tests/issue-3523-module-init-single-pass.test.ts`, 9 cases → 15, all green under
CI's flags (`--pool=forks --poolOptions.forks.singleFork --no-file-parallelism`,
47 s):

- `:236-250` controls `call-in-initializer`, `new-in-initializer`,
  `call-in-static-block`, `tagged-template` → `1/0`;
  `call-in-initializer-arrow-body` stays `1/1` (renamed `arrow-body-calls-local`,
  now one of four closure+call controls);
- `:373-384` inline-route pin `1/1` → `1/0`, byte identity vs forced still holds;
- the eleven-shape closure-free call-bearing family is pinned at `1/0` AND at
  **byte identity** vs forced on both lanes (a stronger claim than gap-1a made);
- new: the two dead-artifact pins (template cache global count 1 vs 2; WASI data
  segment count delta exactly 2), the chunk-forced `1/1` pin, the P4 mutation
  pin, the P2 test262 diagnostics-parity pin, and a multi-source arm proving a
  call alone contributed by an earlier source no longer forces pass 2 while a
  call **plus** a closure still does.

### V-E — gates

`pnpm run typecheck` clean. `pnpm run check:ir-fallbacks` output
**byte-identical** base vs candidate (`diff` empty; no bucket moves). The five
ratchet gates run bare and green, and again under
`LOC_GATE_BASE=$(git rev-parse origin/main)`. LOC `src/codegen/declarations.ts`
+11 and func `compileDeclarations` +11, both granted in this file's frontmatter
with a dated rationale — the +11 is entirely the corrected comment, which is
contract item 3.

After merging `origin/main` (`75818e7ac4`) the headline measurements were re-run
**on the exact artifact being committed**, not inherited from the pre-merge tree:
census 0/116 rows drifted, A/B still 103 identical / 13 differing, corpus still
50/52 with 14 rows newly single-pass, and the seven scar suites green (108
tests).

## 2026-09-02 gap-6 design record — what pass 1 actually produces, and the slice that can retire it

Written by the Fable planning lane against `origin/main` `a7edf000ee` (gap-1b
merged). Every `file:line` below is from that tree. This answers the design
item gap-1b left open ("closure pre-lift inventory ahead of bodies, measured
against Seam B's failure set") with a census first, because the earlier probe
measured pass 1's *removal* (6/89 async regressions) but never enumerated what
pass 1 *writes*.

### Census — every `ctx` collection pass 1 mutates

Probe: `declarations.ts` instrumented to snapshot every Map/Set/array-valued
`ctx` field (plus `mod.{types,functions,globals,imports,tags}` lengths) before
and after pass 1 (`:6005-6007`) and pass 2 (`:6214-6224`), diffed per compile.
Driver, instrumentation and raw JSON:
`/tmp/claude-0/-home-user-js2/28d6498f-fc64-5f6d-952c-7075f472bc2f/scratchpad/r4-instrument.py`,
`r4-shapes.mts` / `r4-shapes.json` (16 shapes × host-deferred + standalone),
`r4-t262.mts` / `r4-t262.json` (every 1,100th official test262 file, harness
assembled by `assembleOriginalHarness`, compiled with the runner's exact
options; 45 sampled, 44 compiled, 39 ran both passes, 5 compile-fail = module
goal / negative phase).

**On the harness sample, pass 1 mutates 45+ collections in 39/39 files.** The
ones that matter are the *discovery* families — name-keyed, decision-changing,
read by the function bodies compiled between the passes. Everything else is a
content-keyed cache that bodies re-mint on demand (order drift only):

| family | fields (writer) | body-side consumers (files outside `declarations.ts`) | harness sample | shape census |
| --- | --- | --- | --- | --- |
| **closure bindings** | `closureMap`, `closureInfoByTypeIdx`, `closureMinimumArgumentCountByFuncTypeIdx`, `constructibleClosureTypeIdxs`, `closureCounter` (`closures/arrow-phases.ts:1283-1322` `registerClosureBindingInfo`, called once per compiled arrow/function expression) | 16 / 36 | **39/39** — keys `print` ×39 and `mkerr` ×39 (the harness prefix's `var print = function…`), then per-test `receiver`, `makeIterable`, `f`, `fn`… | every closure-bearing shape (c9, x2, x5, x6, h1, h2, v1) |
| **integrity end-state** | `frozenVars`/`sealedVars`/`nonExtensibleVars` (`expressions/call-builtin-static.ts:1693-1700`, keyed by `integrityVarKey` → `o@6`), `definedPropertyFlags` (`object-ops.ts:1648` and 7 siblings, key `o@6:x`), `nonWritableExternKeys` (`:662`), `definePropertyReceiverKeys`, `sidecarDefinedPropertyKeys` | 8 files, 24 sites | `frozenVars` **0/39**, `definedPropertyFlags` **5/39** | f1-freeze, f2-defprop only |
| **captured module lexicals** | `capturedGlobals` / `capturedGlobalsWidened` (`closures.ts:1106-1110`, promotes a module-init LOCAL `let/const` to a `__captured_<name>` global when a closure captures it) | 9 | **3/39** | x6 only |
| function-value globals | `funcClosureGlobals`, `funcClosureSingletonKeyByFuncIdx` (`function Test262Error` used as a value) | 3 | 39/39 | h2 |
| host dynamic dispatch surfaces | `hostDynamicClassMethodNames`, `hostDynamicClassAccessorReads`, `memberGet/SetDispatchNames`, `maxHostDynamicMethodCallArity` | 6 | 39/39 (`sameValue`…) | h2 |
| on-demand caches (order drift only) | `funcMap` late imports (`__get_undefined`, `__typeof_*`), `funcTypeCache`, `stringLiteralMap`/`stringGlobalMap`/`nativeStrLiteralGlobals`, `structMap`/`structFields`/`anonTypeMap`/`refCellTypeMap`, `funcRefWrapperCache`, `fnInstanceMeta*`, `pendingMethodTrampolines`, `exnTagIdx`, `currentThisGlobalIdx`, `argcGlobalIdx`, `__funcValueWrapper*` | 351 (funcMap) … 1 | 39/39 | most shapes |

**The classifier is the measured A/B, not this table.** gap-1b's `p2only` run
(`g1-design.md` §1d: skip pass 1 in `full` mode, force pass 2) kept runtime
parity on every shape and lane and on 83/89 runner-faithful test262 files; the
6 failures are all one mechanism — `doneprintHandle.js`'s
`var __consolePrintHandle__ = function (msg) { print(msg); }` compiles, without
a `closureMap` entry for `print`, from a `call_ref` on the closure struct to a
bare `call` through the dynamic `__call_function_*` boundary, `$DONE` inlines
it, and the runner never observes completion. So on the sampled populations the
on-demand caches, the function-value globals and the dispatch surfaces are
re-seeded correctly by the bodies themselves (317/319 files change BYTES —
index order — and 0 change status), and exactly one discovery family is
load-bearing: **closure bindings**. Integrity and capture are load-bearing too
(f1-freeze flips a TypeError to a silent write without pass 1) but they are
rare on test262 (0/39 and 3/39) and can be *gated* rather than inventoried.

### What that settles

1. "Closure pre-lift inventory" is the right first slice, and it is sufficient
   for the sampled harness populations — not because pass 1 writes little, but
   because everything else it writes is either re-derivable on demand or rare
   enough to keep pass 1 for.
2. Byte identity is NOT an acceptance metric for pass-1 retirement. Compiling
   the initializer once, after bodies, reorders every on-demand index; the
   earlier probe measured 317/319 files drifting with zero status change. The
   acceptance metrics are runtime parity, test262 status parity on the
   runner-faithful sample, and the `p2only` failure set going to zero.
3. There is a measurable *win* beyond compile time (pass 1 ≈ 13–15% of a
   test262 compile): pass 2 today mints a dead re-lifted `$__closure_N` twin per
   module-level closure (gap-1b census, "closure-bearing populations differ").
   With no pass 1 there is no twin — `mod.functions` shrinks by one per
   module-scope closure. That is pinnable.

### Slice gap-6a — module-scope closure pre-lift + `discovery-static` pass-1 skip

**Contract**

1. **`src/codegen/declarations/module-init-closure-prelift.ts`** (new) —
   `preLiftModuleClosures(ctx): ModuleClosurePreLift`. Walk
   `ctx.moduleInitStatements` **top level only** (a closure nested inside a
   top-level function body registers when THAT body compiles, between the
   passes, exactly as today) for the two binding shapes
   `registerClosureBindingInfo` registers (`arrow-phases.ts:1303-1322`):
   `VariableDeclaration` (`var`/`let`/`const`) whose initializer is an
   `ArrowFunction` or `FunctionExpression`, and an `ExpressionStatement`
   `<ident> = <ArrowFunction|FunctionExpression>` whose target is a module
   global (`ctx.moduleGlobals.has`). For each site run the DECLARE half of
   `compileArrowAsClosure` and nothing else: `planClosureCaptures`
   (`closures.ts:3559`), `mintClosureStructTypes` (`:3586-3603`, with the same
   `constructible: callableHasConstructBehavior(arrow)`), the
   `closureStructByNode` record (`:3606`), and `registerClosureBindingInfo`
   with `inlineBody` undefined. Do NOT compile the body
   (`compileLiftedClosureBody`, `:3614`), do NOT mint the lifted function
   (`:3631`), do NOT emit construction (`arrow-phases.ts:1148`). The record
   returned lists every pre-lifted site and every site REFUSED (see 3) with a
   reason.
2. **Idempotent re-mint.** When the initializer later compiles for real (pass
   2), `compileArrowAsClosure` must REUSE the pre-minted struct/func types and
   the registered `ClosureInfo` instead of minting a second struct: consult
   `closureStructByNode` (`context/types.ts:3000`) before `:3586`. Capture-free
   closures already share a signature-keyed wrapper (`funcRefWrapperCache`) so
   they are idempotent today; capture-carrying closures mint per-closure
   (`arrow-phases.ts:908`) and are not — probe P2 measures which shapes need
   the node-cache short-circuit. The `ClosureInfo` registered by the pre-lift
   and the one the real compile would register must be deep-equal except
   `inlineBody`; pin that.
3. **Refusals (fail-closed, each a named reason in the record):** a closure
   whose `planClosureCaptures` result names a module-init LOCAL (a module-scope
   `let`/`const` — the capture family, `closures.ts:1106`) — probe P3 says
   whether the plan can even be computed without the module-init `fctx`;
   generators/async closures (`isGenerator`/`isAsync` paths in
   `compileLiftedClosureBody` carry their own state); a closure whose parent is
   a `PropertyAssignment` (never registered, `:1324-1327`); anything the
   population-level scan (4) refuses.
4. **The gate** — `moduleInitDiscoveryIsStatic(ctx, preLift): boolean` in the
   same file, fail-closed like `moduleInitPopulationIsPass2Stable`
   (`declarations/module-init-pass2-stable.ts`): true iff (a) the pre-lift
   refused nothing, (b) a full-subtree scan of the population finds NO
   `Object.freeze/seal/preventExtensions/defineProperty/defineProperties` call
   and no `Reflect.*` integrity call (the integrity family stays on pass 1),
   (c) no `Decorator`, `AwaitExpression`, class static block, or class
   expression (gap-1b's refusals, unchanged), (d) `moduleInitMode === "full"`
   on a single-source graph — `"discover"` mode exists to run pass 1 for the
   whole graph (`declarations.ts:4406-4415`) and is out of scope.
5. **Wiring in `compileDeclarations`.** Pass 1 (`:6003-6013`) gains
   `&& !discoveryStatic`; the pass-2 condition (`:6209-6213`) gains
   `|| discoveryStatic` so the initializer compiles exactly once, after the
   bodies. With no pass 1, `restorePropOrderState()` is a no-op by construction
   (snapshot == live state) and `dedupeDiagnosticsFrom(ctx, pass1DiagnosticMark)`
   sees an empty pass-1 range (P4 confirms it is a no-op, not a truncation).
   `ctx.pendingInitBody` stays `null` until pass 2 — P4 confirms every
   `pendingInitBody` fixup (`registry/imports.ts:453-456, 742-744, 1058-1060`;
   `expressions/late-imports.ts:245-247, 896-898`) is null-safe.
6. A test-only env seam `JS2WASM_TEST_DISABLE_MODULE_INIT_PRELIFT=1` that runs
   the gate WITHOUT the pre-lift (registrations skipped, gate still true) so
   the load-bearing pin in (d) below is a mutation, not an argument — the same
   pattern gap-1b used for its closure refusal.
7. Profile counters: `module-init-pass1` stays; add `module-init-prelift` and
   `module-init-discovery-static` (`profileCount`) so the census reads
   `pre-lift/p1/p2` per compile.

**Required pre-implementation probes (answers in the checkpoint note)**

- **P1** — where the production `registerClosureBindingInfo` call sits
  (`grep -rn "registerClosureBindingInfo"`; only the DOM-callback authority
  matched by that spelling on this tree, so the main call is spelled through a
  phase helper) and whether any between-pass body consumer reads
  `ClosureInfo.inlineBody` (expected: only the registry inliner INSIDE closure
  bodies compiled during init, gap-1b P2 — so `undefined` at pre-lift time
  costs nothing between the passes).
- **P2** — the re-mint: compile x5 (`const add = (a, b) => a + b`), h1 and a
  capture-carrying `const k = 3; const f = () => k` twice through the declare
  half and check `mod.types` grows once; then find where `compileArrowAsClosure`
  must consult `closureStructByNode` so the real compile reuses the pre-minted
  `structTypeIdx` (the body's `ref.cast` and the init's `struct.new` must name
  the SAME type index — that is the whole point).
- **P3** — `planClosureCaptures` without a real module-init `fctx`: what it
  reads from `fctx` (`localMap`, `boxedCaptures`, …) and whether a synthetic
  frame that knows only module globals / function declarations / imports is
  enough to (i) compute captures for the admitted shapes and (ii) DETECT a
  module-lexical capture so the gate can refuse it. If not, the pre-lift admits
  only closures whose free identifiers all resolve to `ctx.moduleGlobals`,
  `ctx.funcMap` or imports — state the measured admission rate.
- **P4** — no-pass-1 safety: `pendingInitBody` null in every fixup;
  `dedupeDiagnosticsFrom` on an empty range; `fixupModuleGlobalIndices`;
  multi-source `"skip"` mode never sees the gate true.
- **P5 (the acceptance measurement, run BEFORE wiring the gate)** — re-run the
  `p2only` A/B from gap-1b (`census-3523-gap1-ab.mts` + the seams in
  `census-3523-gap1-seams.diff`, both in the scratchpad) with the pre-lift
  installed: the 6 async regressions on the 89-file runner-faithful sample
  must go to **0** with the pre-lift alone, h1's `read()` must contain
  `call_ref` and no `__call_function_*` import, and x5 must not grow (gap-1b
  measured 86 → 182 WAT lines without pass 1). If any regression survives,
  the failing file names the next inventory family — record it, do not widen.

**Tests** — new `tests/issue-3523-module-init-discovery-static.test.ts`:

- (a) census — h1-print, h2-assert, v1-var-fnexpr, x5, x2, c9 × 4 lanes
  (host-start, host-deferred, standalone, wasi) report `pre-lift=1 p1=0 p2=1`;
  x6 (module-lexical capture), f1-freeze, f2-defprop, a `static {}` shape and a
  `"discover"`-mode two-source graph report `p1=1` (refused, reason named).
- (b) dispatch parity — for h1 and x5 the body's WAT contains `call_ref` and
  no `__call_function_*` / `__call_fn_*` import; the `ref.cast` type index in
  the body equals the `struct.new` type index in `__module_init`.
- (c) runtime parity — every (a) shape on host + standalone, IR on and off.
- (d) load-bearing — under `JS2WASM_TEST_DISABLE_MODULE_INIT_PRELIFT=1` h1's
  body loses `call_ref` (the gap-1b `p2only` signature) — the inventory is
  measured, not assumed.
- (e) the dead twin — for every admitted closure-bearing shape,
  `mod.functions.length` is exactly one smaller than the forced two-pass build
  (`JS2WASM_TEST_FORCE_MODULE_INIT_PASS2=1` with the gate off) per
  module-scope closure; `WebAssembly.validate` on all lanes.
- (f) diagnostics — a population with a duplicate top-level diagnostic
  (`for-in/cptn-decl-itr.js` shape) reports it exactly once with no pass 1.
- Existing pins that MOVE (deliberately, named): the `1/1` controls in
  `tests/issue-3523-module-init-single-pass.test.ts` for closure-bearing
  shapes become `0/1`; the byte-identity-vs-forced pins do NOT apply to
  discovery-static populations (bytes reorder by design) and must be scoped to
  populations the gate refuses.

**Verification** — V-A shapes × 4 lanes (census, WAT, runtime); V-B corpus
`website/playground/examples/**` + `examples/**` host + standalone: zero
success/error divergence, runtime parity where a `read`-style export exists;
V-C the 319-file test262 compile sample: error-count divergence 0; V-D the
89-file `runTest262File` sample: `pass 62 → 62`, and the six `p2only` files
named individually (`Promise/allSettled/iter-assigned-undefined-reject.js` et
al. — rebuild the list from the A/B); V-E `check:ir-fallbacks` byte-identical
output, the five ratchets bare and under `LOC_GATE_BASE=origin/main`,
typecheck/lint/prettier, the seven scar-family suites gap-1b lists (108 tests)
plus this suite. LOC: new file ≈ 180, `declarations.ts` ≈ +25, `closures.ts`
≈ +10 — grant in this file's frontmatter with a dated rationale.

**Out of scope** — the integrity and capture families as *inventories*
(gap-6b, only if the full-census admission rate after 6a says they are worth
it: 0/39 and 3/39 on this sample say not yet); `"discover"`-mode multi-source
graphs; IR-owned call-bearing admission (the R4 endgame, `select.ts` Gate 2
against the real claimed set — still zero test262 yield until the selector
admits harness-shaped populations); gap 5 (R3); byte identity across the
pass-1 skip (reorders by design — say so in the checkpoint, do not pin it).

**Sequencing** — dispatch after the F2-S4/F2-S5 lanes have landed (CPU), from
`origin/main`; no dependency on #3526. Claim the sub-slice as `3523:gap6a`.

## 2026-09-02 gap-6a checkpoint note — Opus lane

Branch `claude/issue-3523-gap6a-closure-prelift`, based on `origin/main`
`ef6aec3322`. Five files: the new
`src/codegen/declarations/module-init-closure-prelift.ts` (368 lines),
`src/codegen/declarations.ts` (+49, wiring only), the new suite
`tests/issue-3523-module-init-discovery-static.test.ts` (11 cases), the moved
pins in `tests/issue-3523-module-init-single-pass.test.ts`, and this file. No
`src/ir/**` edit, no selector, no prepared route, no `"discover"`/`"skip"`
change — as the contract requires.

Every figure below is from a run on this branch. The base was captured by file
copy at the first edit (`.tmp/base-declarations.ts`, `.tmp/base-closures.ts`,
`.tmp/base-arrow-phases.ts`) and flipped with `cp`, never `git stash`.
**Interrupted and resumed:** a container restart killed the session at ~09:10
UTC on 2026-09-02 mid-verification, and work resumed in a second worktree from
the same branch tip, the same uncommitted diff and the same `.tmp/` artifacts.
**Every figure below is post-narrowing** — no first-cut number was left
standing. Provenance splits two ways: the compile samples (V-C), the corpus
bytes (V-B), the 90-file runtime sample, the mutation and the eight equivalence
shards are the pre-restart session's completed second-round runs (`.tmp/g6b-*`,
08:19–09:07 UTC); the nine suites, the `#4376` A/B, the five ratchets,
`check:ir-fallbacks` and the `#5274` standing-red set were re-measured after the
resume on the final tree.

### The mechanism the slice is actually built on — and how it differs from the plan

The plan's contract says the pre-lift must run the DECLARE half of
`compileArrowAsClosure` and that the real compile must then REUSE the pre-minted
struct/func types (`closureStructByNode` short-circuit, contract item 2). P2
measured that no short-circuit is needed, and P3 measured why:

**A call site does not consume the closure's own struct type.**
`compileClosureCall` (`expressions/calls-closures.ts:900`) derives its
`ref.cast` target from `getClosureFuncSelfTypeIdx(ctx, info.funcTypeIdx)` — the
SELF parameter of the lifted func type — and only falls back to
`info.structTypeIdx` when that func type is private. Both the lifted func type
and the wrapper root are keyed by SIGNATURE. `mintClosureStructTypes`
(`closures/arrow-phases.ts:975-989`) gives a capture-CARRYING closure the
wrapper's own `liftedFuncTypeIdx` and a struct that SUBTYPES the wrapper root.

Measured on the `h1` harness shape (`var __consolePrintHandle__ = function
(msg) { print(msg); }`), host-deferred lane:

| | struct | super | fields | lifted func type | wrapper |
| --- | --- | --- | --- | --- | --- |
| pass 1's mint | 16 | 13 | 5 | 14 | 13 / 14 |
| pass 2's mint | **24** | 13 | 5 | 14 | 13 / 14 |
| the body's cast | — | — | — | — | **13** (`ref.cast (ref 6)` in the emitted WAT, the `$__fn_wrap_1_struct` root) |

Pass 2 already mints a DIFFERENT struct from pass 1 today, and the body works
anyway, because the cast names the root. So the pre-lift can mint the wrapper
with an EMPTY capture list, register, and never compile a body, mint a lifted
function, or emit a construction — and the single compile that runs later is
free to mint whatever per-closure subtype it wants.

That is the deviation, and it is a simplification: **no reuse plumbing was added
to `compileArrowAsClosure` at all.** `closures.ts` and
`closures/arrow-phases.ts` are UNCHANGED by this PR.

A second deviation follows from it. The plan's refusal list is built around
captures (module-lexical capture, `planClosureCaptures` without a real `fctx`).
Captures turn out to be irrelevant to what the bodies read, so the shipped
refusals are the cases where the SUBTYPE/func-type relation does not hold, plus
the population-level ones — see the table below.

### P1 — where the registration lives, and what `inlineBody: undefined` costs

`grep -rn "registerClosureBindingInfo" src/` gives exactly two hits: the
definition (`closures/arrow-phases.ts:1271`) and ONE production call, in
`registerStandaloneDomCallbackDirectClosure`
(`standalone-dom-callback-authority.ts:356`), which `compileArrowAsClosure`
invokes at `closures.ts:3813`. That call sits AFTER `compileLiftedClosureBody`
and after `mintDefinedFunc`, because its `inlineBody` argument is
`captureFreeNumericInlineBody(arrow, captures.length, liftedFctx, …)` — it needs
the lifted frame. The pre-lift therefore calls the bare
`registerClosureBindingInfo`, not the DOM-callback wrapper (which additionally
allocates a certified carrier from a `liftedFuncIdx` that does not exist yet).

`ClosureInfo.inlineBody` has exactly one reader outside `src/ir/`:
`array-methods.ts:6476/6478/7608`, the array-callback inliner. So `undefined` at
pre-lift time costs one optimization inside array callbacks compiled between the
passes, and nothing else; the real registration overwrites the entry with the
complete `ClosureInfo` when the initializer compiles.

### P2 — the re-mint: idempotent where it matters, and the three shapes where it is not

Instrumented `compileArrowAsClosure` (throwaway, reverted from the base copies;
`.tmp/instr-p2.py`), 10 shapes × 2 lanes:

- **capture-free, anonymous** — pass 1 and pass 2 mint the SAME indices (`c9`
  struct 12 / ftype 13 both passes; `x11`'s two same-signature arrows both get
  struct 12). `getOrCreateFuncRefWrapperTypes` and
  `getOrCreateConstructibleFuncRefWrapperTypes` are signature-keyed caches, and
  `ensureFnMetaSubtype` is keyed by base type. Minting twice is a no-op.
- **capture-carrying** — a fresh struct per compile (`h1` 16 → 24, `x12` 15 →
  18), always `sub` the wrapper root, always sharing the wrapper's lifted func
  type. Harmless for the reason above.
- **named function expression** — `v3`: struct 14 `sub` 12, but ftype **15**,
  NOT the wrapper's 13. The private lifted func type is why this is refused.
- **concise-body return repair** — `generic.liftedFuncTypeIdx !== minted` was
  `undefined` on all 20 cells, but the repair exists (`closures.ts:3290`) and
  fires when a concise body lowers to `f64` under a declared `externref` return
  with no reachable `__box_number`. Only a body compile can know, so the shape
  is refused wholesale.

### P3 — the synthetic frame, and what it can and cannot see

The module-init frame is created empty (`createModuleInitFunctionContext`: no
params, no locals, empty `localMap`), so `planClosureCaptures` against a fresh
one returns `[]` for every closure by construction — every name misses
`localMap` and the `fctx.locals` rescan.

The REAL frame is not empty by the time later statements compile, and it does
produce captures — measured, `h1`'s `__consolePrintHandle__` captures `print`
from a module-init staging local, and `x12`'s `two` captures `one`. **Every
capture name measured was also a module GLOBAL** (`ctx.moduleGlobals.has` true,
`mutable` false). Two shapes the gap-6 plan expected to be capture-carrying are
not: `x6` (`let count = 0; const inc = () => { count = count + 1 }`) and a
`const k = 3; const f = () => k` variant both compute `[]` — a module-scope
`let`/`const` is a module GLOBAL here, not a module-init local. The
"captured module lexicals" family is therefore narrower than the census table
suggested, and **x6 is ADMITTED**, not refused; its runtime parity is pinned.

Because the registration is wrapper-derived, none of this needed a refusal.

**Admission rate** under the shipped keyed-site rule: **223/325** runner-faithful
test262 harness populations on the host lane (68.6%) and **24/163** on the
standalone lane (14.7%) — the two lanes differ by a factor of five for a reason
named in V-C. 0/56 on the corpus (`website/playground/examples/**` +
`examples/**` × host/standalone) — those programs all carry a class expression,
a static block, an integrity call or a nested closure.

### P4 — no-pass-1 safety

- **`pendingInitBody`**: all five fixup sites are already `if
  (ctx.pendingInitBody)`-guarded (`registry/imports.ts:453,742,1058`;
  `expressions/late-imports.ts:245,896`) and the field initialises to `null`
  (`context/create-context.ts:361`). With no pass 1 every fixup is a no-op.
- **`dedupeDiagnosticsFrom`** is NOT a no-op, and the first cut got this wrong.
  Guarding it on "pass 1 ran" left
  `language/statements/for-in/cptn-decl-itr.js` reporting **2** errors where the
  two-pass build reports **1**. The mark is a program POSITION, not a pass-1
  artifact: it is now taken unconditionally at the point pass 1 would start, and
  the dedupe still runs after the single compile. Measured after the fix: 1 vs
  1, and 0 error-count divergences over 325 harness files.
- **`fixupModuleGlobalIndices`** is one of the five guarded sites above.
- **multi-source**: `"discover"`/`"skip"`/`"prepared"` are refused by
  `moduleInitMode !== "full"`, and a `"full"`-mode source whose accumulated
  `ctx.moduleInitStatements` contains a statement from another `SourceFile` is
  refused by `population-multi-source`. Pinned: a two-source graph still reads
  `pass1 = 2`.

### P5 (the acceptance measurement, run before the gate was wired)

Runner-faithful `runTest262File`, deterministic 90-file sample (every 546th
official file under `test/language`, `test/built-ins`, `test/annexB`):

| run | pass | fail | skip | status divergences |
| --- | --- | --- | --- | --- |
| candidate (pre-lift + one compile) | **71** | 18 | 1 | — |
| forced two-pass control | 70 | 19 | 1 | **1, in the candidate's favour** |
| gate ON, inventory OFF (`JS2WASM_TEST_DISABLE_MODULE_INIT_PRELIFT=1`) | 66 | 23 | 1 | **5** |

**Zero regressions.** The five files the inventory rescues, by name:

- `test/language/expressions/class/dstr/async-private-gen-meth-static-obj-ptrn-prop-ary-init.js`
- `test/language/statements/for-await-of/async-func-dstr-var-async-ary-ptrn-rest-id-elision.js`
- `test/language/statements/for-await-of/async-gen-dstr-var-ary-ptrn-elem-id-iter-done.js`
- `test/built-ins/AsyncGeneratorPrototype/return/this-val-not-async-generator.js`
- `test/annexB/language/eval-code/direct/global-switch-case-eval-global-existing-block-fn-no-init.js`

Four are the async `p2only` family gap-1b measured (`$DONE` never observed). The
fifth is the file the route ALSO gains against the two-pass control, so it is
not an inventory effect — see "known difference" below.

Dispatch, host lane, `h1` and `x5`:

| | `$DONE` lines | `call_ref` in `$DONE` | `__call_function_*` imports | module bytes |
| --- | --- | --- | --- | --- |
| `h1` candidate | 180 | 2 | 4 | 4 638 |
| `h1` two-pass | 180 | 2 | 4 | 4 851 |
| `h1` inventory OFF | **273** | **8** | **5** | **8 410** |

`h1`'s `$DONE` differs from the two-pass build only in `call N` operands (the
dead twin's index shift) — character-identical otherwise. `x5`'s `$read` is 94
lines on both routes and **282** without the inventory (module 3 211 → 12 659
bytes), so the plan's "x5 must not grow" holds with room to spare.

### The two families that survived — recorded, not widened

A module-scope closure whose body mints a nested closure that ESCAPES is not
servable by an AST-level inventory: `const mk = () => { const inner = () => 5;
return inner; }` registers `inner` while pass 1 compiles `mk`'s LIFTED body, and
a between-pass `mk()()` loses the second-level dispatch — measured `read() = 0`
instead of `5` on host AND standalone, with the standalone module ballooning
128 846 vs 53 560 bytes.

A 21-variant probe (`.tmp/g6a-variants.mts`) isolated it: only "returns a nested
closure that is then called" diverges. A nested closure that is NOT returned, an
object-literal method, an array callback and a nested generator are all fine.
The shipped refusal is nevertheless the **syntactic, fail-closed** one — any
nested function-like or class-like inside the site's body — because escape
analysis is not this slice's job. Cost, measured: 4 of the 21 variants
(`v4`, `v11`, `v12`, `v19`) are refused that need not be, and each is
byte-identical to its two-pass control when refused. After the refusal: **0
divergences across 21 variants × 2 lanes.**

**The second family was found by a GATE, not by a probe, and it is the one that
changed the contract.** The pre-push hook's `#3765 numeric-locals` check went
red on `tests/issue-3765-numeric-locals.test.ts > is off under the kill switch,
restoring the boxed carrier` — 18/18 on the base tree, 17/18 with the first cut.
Its fixture's whole init population is

```js
Tok.prototype.nextCode = function () { … };
Tok.prototype.run      = function () { … };
```

a pair of **write-once fnctor prototype methods**. `admitTypedThisTwin`
(`typed-this.ts:224`) and `recordDirectCallGeneric` (`:1009`) both gate on
`resolveEnclosingFnctorOwner(...).viaPrototype`, so compiling those closures is
what mints the #3683 typed-`this` twin and the #3765 direct-call carrier that
the bodies compiled BETWEEN the passes consume. Moving that compile to pass 2
changed the twin's emitted body.

The fix is a narrowing of what counts as a SITE: **only the two shapes
`registerClosureBindingInfo` actually KEYS in `closureMap`** — `var/let/const
<ident> = <closure>` and `<ident> = <closure>`. A `<obj>.<prop> = <closure>`
publishes no `closureMap` entry, so pre-lifting it buys nothing; and because the
gate additionally requires at least one site, a population whose closures are
ALL property assignments (the pure-fnctor shape) is refused outright and keeps
pass 1. `#3765` is green again at 18/18.

Two narrower rules were tried first and MEASURED to be unusable, both because
the runner-faithful harness carries the shapes they refuse:

| rule | admission on an 82-file host-lane harness sample |
| --- | --- |
| refuse any unkeyed function-like in the population | **0/82** — the `$262` runtime shim is an object literal of methods |
| also refuse any `.prototype` member access | **0/82** — `sta.js` has `Test262Error.prototype.toString = function …` |
| refuse a closure nested in ANY population closure | **0/82** — the shim has `function () { return function (msg) { this.message = msg; }; }` |
| **shipped**: keyed sites only, nesting refused inside a SITE's body | **58/82** |

**Residual risk, stated plainly:** a MIXED population — one that has a keyed
site AND a fnctor prototype method, which is exactly the test262 harness — is
still admitted, so that prototype method's twin still moves from pass 1 to
pass 2. It is measured at parity on everything this slice can measure (0
error-count / 0 success divergence over 325 host + 163 standalone compiles, 0
status divergence over 90 runtime files, 8/8 equivalence shards) but it is NOT
pinned, because a twin-body difference is invisible to status and error counts.
The `merge_group` standalone floor is the backstop.

The in-source comments were corrected on the resume to say that, because the
first cut left the STRICT rule's wording standing next to code that enforces
neither half of it — "EVERY function-like or class-like node in that subtree
must be one of the keyed sites", and "those closures therefore REFUSE the
population". Neither is true of the shipped gate: `populationRefusal` never looks
at unkeyed function-likes, and the only thing that keeps the pure-fnctor shape on
pass 1 is `sites.length === 0`. A comment asserting an invariant the code does
not hold is worse than no comment, because the next reader builds on it — so
both now state the actual rule, name the 0/82 measurement that rules the strict
one out, and point here for the mixed-population risk.

### Known difference, named rather than hidden

On an ADMITTED population a **pass-1-only compile refusal moves to the JS
runtime error channel**. `const f = (): number => 1; const nn: number = f();
const [p, q] = nn as unknown as number[];` is refused by pass 1 (`Cannot
destructure: not an array type`); the compile that runs after the function
bodies does not refuse it — and neither does the two-pass build's own pass 2, so
the refusal was always pass 1's alone. With pass 1 gone the module compiles and
throws the §7.4.3 `TypeError` at run time instead.

Direction: toward the language (`const [p] = 1` throws in JS). Measured impact:
**0 error-count and 0 success divergences across 325 runner-faithful test262
compiles**, and +1 pass on the 90-file runtime sample. The same population with
a plain function instead of a closure is gate-refused and keeps the compile
error, which is what makes this a property of the ROUTE, not of the destructure.
It has its own pin in the new suite.

### V-A — census, admitted and refused, 4 lanes

Every admitted shape reads `pre-lift = 1, pass1 = 0, pass2 = 1` on
host-start / host-deferred / standalone / wasi, and every refused one keeps
`pass1 = 1`:

| family | shapes | census |
| --- | --- | --- |
| harness + arrow/fn-expr | `h1`, `h2`, `v1`, `x5`, `x2`, `c9`, `x6`, `v2` | `1/0/1` × 4 lanes |
| refused | nested closure, named fn expr, generator, `Object.freeze`, `Object.defineProperty`, static block, class expression, no closure at all | `0/1/x` × 4 lanes |

Each refusal in the suite ships with the ADMITTED twin that removes exactly the
refusing feature. That is a deviation from the plan's "reason named": a refusal
record has no observation channel that would not add production surface, and a
differential twin is a stronger claim than reading a string back.

`mod.functions` is smaller by exactly one per module-scope closure on every
admitted shape and lane (`h1` 22 vs 24, `h2` 25 vs 27, the single-closure shapes
−1) — the dead re-lifted `$__closure_N` twin, pinned.

### V-B — corpus: byte-identical to the base tree

`website/playground/examples/**` + `examples/**`, 28 files × {gc, standalone,
wasi} = **84 rows, 84/84 sha256-identical between the base tree and this
branch** (file-copy A/B on `declarations.ts`). Separately, candidate vs forced
two-pass over 56 host/standalone rows: 0 success, 0 error-count and 0 runtime
divergences. The gate admits **0/56** of the corpus, so this slice is provably a
no-op there.

### V-C — runner-faithful compile samples, both lanes

Every Nth official file under `test/language`, `test/built-ins`, `test/annexB`,
harness assembled via `assembleOriginalHarness`, compiled with the runner's
options, candidate vs the forced two-pass build. **Both lanes re-run after the
keyed-site narrowing** — these are the shipped rule's numbers, not the first
cut's:

| | host (deferred) | standalone |
| --- | --- | --- |
| measured | 325 / 325 | 163 / 163 |
| admitted (discovery-static) | **223 (68.6%)** | **24 (14.7%)** |
| error-count divergence | **0** | **0** |
| success divergence | **0** | **0** |
| admitted modules smaller / equal / bigger | **223 / 0 / 0** | **22 / 2 / 0** |

**The standalone lane is where the narrowing was paid for, and the bill is
visible: admission fell 111 → 24 there while the host lane went 222 → 223.**
Both moves follow from the one rule change. `<obj>.<prop> = <closure>` used to be
a CANDIDATE carrying an undefined binding, so `siteRefusal` could reject it and
take the whole population down with it — the host lane loses exactly one such
refusal, hence +1. It is now not a candidate at all, so a population whose
closures are ALL property assignments has zero sites and is refused by
`population-has-no-pre-liftable-closure`; the standalone harness is dominated by
that shape, hence −87. **Divergence stayed at 0 on both lanes across the
narrowing**, so this is a payoff loss, not a correctness signal — and since the
residual fnctor risk lives in the standalone lane, that is the side to lose
payoff on. It also means gap-6b's inventories, if they are ever wanted, are
worth more to standalone than the 68% host figure alone suggests.

### V-E — gates and suites

- Five ratchets bare: `check-loc-budget` `check-func-budget`
  `check-coercion-sites` `check:oracle-ratchet` `check:dead-exports` — all exit
  0, and again under `LOC_GATE_BASE=$(git rev-parse origin/main)`.
- LOC `src/codegen/declarations.ts` **6478 → 6526 (+48)** against the merge-base
  and **6496 → 6526 (+30)** against `origin/main` at `c91ac6ea` (main moved that
  file underneath the branch), func `compileDeclarations` **1316 → 1358 (+42)**
  — both granted in this file's frontmatter with a dated rationale. The new
  subsystem module is not a budgeted file.
- `pnpm run typecheck` clean. `npm run lint` exit 0. `prettier --check` clean on
  every file this PR touches (the one repo-wide warning,
  `tests/dogfood/setup-lit-upstream-suite.mjs`, is untouched and pre-existing on
  `main`).
- `check:ir-fallbacks` exit 0, and its output **byte-identical** between the
  candidate and the forced two-pass control (`diff` empty) — re-run on the final
  tree through the `JS2WASM_TEST_FORCE_MODULE_INIT_PASS2` seam rather than a
  file-copy base, so the comparison isolates this slice from main's drift.
- **All eight `equivalence-gate` shards exit 0** — "No new equivalence
  regressions" on every one (1 718 passing, 24 known-failures per shard's
  baseline).
- **Nine scar-family suites green on the final tree, re-run after the keyed-site
  narrowing: 137 tests, 0 failures.**
  `issue-3523-ir-module-init-compile-once` (20), `issue-3872` (28),
  `issue-2965` (11), `issue-4182-annexb-global-blockfn` (9),
  `issue-4195-eval-refusal-message-and-dedupe` (6),
  `issue-4376-module-init-chunking` (19), `issue-3765-numeric-locals` (18),
  `issue-3523-module-init-single-pass` (15) and the new
  `issue-3523-module-init-discovery-static` (11). (The first cut of this note
  wrote "93 tests" next to the `issue-3523-ir-module-init-compile-once` name;
  93 was the SUM of a six-suite run and that suite is 20. Corrected by
  re-measuring, not by re-parenthesising.)
- **`#4376`'s `preserves TDZ ordering for const writes and updates` sits within
  ~2 s of vitest's 35 s default timeout on this 4-core box — on BOTH routes.**
  It timed out once at 35 142 ms in a run sharing the box with other work, which
  is the check the resumed session had been about to redo. Quiet box, same `-t`
  filter, isolated A/B: candidate **28 452 ms** vs forced-two-pass control
  **31 304 ms**, and the whole file is **19/19 in 87.9 s**. The pass-1 skip makes
  that test faster, so the timeout was ambient load, not gap-6a — but the margin
  is thin enough that a loaded CI runner can flake it independently of this
  slice, which is worth knowing before the next person blames a diff for it.
- The 17 standing reds of
  [#5274](https://js2wasm.loopdive.com/dashboard/issue.html?slug=5274-standing-red-tests-string-and-3529-suites)
  measured on THIS base tree: **17 failed / 47 passed before the edit and 17 /
  47 after, the same 17 by name.** Re-measured once more on the final tree after
  the keyed-site narrowing: still 17 / 47, still the same 17 by name (`diff` of
  the sorted FAIL lists is empty). No growth. **Then `origin/main` at
  `f64beb1a03` was merged in and the family went green — 64 / 64, zero reds:**
  `#5274` was fixed on main while this branch was in flight, so the comparison
  above is now history. What it still establishes is the only thing it was ever
  asked to: gap-6a added none of them.
- **Post-merge re-validation** against `origin/main` `f64beb1a03`, which itself
  edits `src/codegen/declarations.ts` (+20) — the file this slice wires into, so
  the merge is not a formality: `pnpm run typecheck` clean; the five ratchets
  green bare and again under `LOC_GATE_BASE=$(git rev-parse origin/main)`; the
  three target suites **44/44**
  (`issue-3523-module-init-discovery-static` 11, `issue-3523-module-init-single-pass` 15,
  `issue-3765-numeric-locals` 18); and the two module-init scar suites **39/39**
  (`issue-3523-ir-module-init-compile-once` 20, `issue-4376-module-init-chunking` 19).
  **On the merged tree the `#4376` TDZ case took 34 597 ms — 403 ms of headroom
  under vitest's 35 s default.** It passed, and the A/B below says the pass-1
  skip makes it faster rather than slower, but the margin is now small enough
  that a loaded CI runner will flake it sooner or later. That is worth raising
  as its own issue against `#4376`, not as a gap-6a blocker.

### Pins that MOVED, deliberately

In `tests/issue-3523-module-init-single-pass.test.ts`:

- `arrow-initializer` and the four `CLOSURE_PLUS_CALL_SHAPES` are
  discovery-static, so their single compile moved from the pass-1 slot to the
  pass-2 slot: `1/0` and `1/1` become `0/1`. A `Shape.discoveryStatic` flag
  drives the expectation so the move is explicit at each shape, not hidden in
  the assertion.
- Each group keeps a gap-6a-REFUSED witness so gap-1b's own predicate stays
  under test: `named-fn-expression-initializer` (call-free, closure-bearing,
  `1/0`) and `named-fn-expression-calls-local` (`1/1`). The P4 closure-admission
  mutation and the closure+call diagnostics arm both moved onto the latter.
- The `cptn-decl-itr.js` pin reads `0/1` and keeps its error-count parity
  assertion — which is the assertion that caught the dedupe-mark bug.

**Byte identity across the pass-1 skip is NOT a metric and is not pinned.** The
initializer compiles in a different slot, so on-demand indices reorder by
design; the dead twin's removal alone shifts every later function index. The
metrics are runtime parity, status parity, error-count parity and the dead-twin
count.

### Not touched

`src/ir/**` (the #3526 F2 lanes own it), the IR selector, the prepared route,
`"discover"`/`"skip"` multi-source modes, `closures.ts`,
`closures/arrow-phases.ts`, the TDZ seam, the poison seam, the WASI
`__init_done` reservation, `scripts/*-baseline.json`. gap-6b's integrity and
capture INVENTORIES stay out of scope — the measured admission rate (68% of the
harness sample without them) says they are not the next bottleneck; the nested
escaping closure is.

## 2026-09-02 gap-6a v2 repair record — Opus lane

Branch `claude/issue-3523-gap6a-v2`, based on `origin/claude/revert-5474-gap6a`
(`66ca1af6a7`, the revert of the first landing's merge commit `48724f80f6`). The
slice is re-applied as one commit and then **narrowed to opt-in**: the pre-lift,
the gate, the census counters and the suite all ship, and the pass-1 skip they
drive is **OFF by default** behind `JS2WASM_ENABLE_MODULE_INIT_DISCOVERY_STATIC=1`.
A default build takes exactly the two-pass path `origin/main` takes today.

**The correction that frames everything below: compile "success" is not
instantiation.** The first lane's acceptance evidence was 325 host + 163
standalone runner-faithful COMPILE samples at 0 error/success divergence. Nine of
the 76 regressions are `WebAssembly.instantiate()` compile errors on a module the
compiler reported as successful — an ill-typed module the compile lane cannot
see, because nothing in it validates the binary. Every runtime figure in this
record comes from `runTest262File`, which compiles, instantiates, runs, and runs
the strict rerun.

### R1 — reproduction, base vs candidate, runner-faithful

`runTest262File` (host lane, the runner's own options via
`assembleOriginalHarness`) over all 87 files the merge-group report names —
the 76 pass→other rows, the 5 improvements, the 4 `Array/prototype/find*` rows
and the 3 Temporal rows. Base = this branch's parent (`origin/main` minus
gap-6a); candidate = the first landing's tree, re-applied:

| | base | candidate |
| --- | --- | --- |
| pass | **77** | 5 |
| fail | 10 | 82 |
| status divergences vs base | — | **80** (76 pass→fail, 4 fail→pass) |

The 76 pass→fail rows are exactly the merge group's list, reproduced
deterministically off CI. **Not reproduced locally: the 32 Temporal
fail→compile_error rows and the 4 `Array/prototype/find*` compile_error→fail
rows** — the 3 Temporal and 4 find rows sampled here are at parity on both trees
(the local Temporal provider builds from cache; the CI transitions are most
likely provider-build/timeout effects at shard level). They are named here rather
than counted as explained.

**Admission census: 87/87 of those files' populations are ADMITTED**
(`module-init-prelift = 1, module-init-pass1 = 0, module-init-pass2 = 1`).
Not one regression is on a population the gate refused, so no refusal was
mis-stated — the gate admits exactly what it says it admits, and what it admits
is unsound.

### R2 — the discriminating matrix, and what it rules out

Five files, one per cluster, on four routes:

| route | decodeURI A1.10_T1 | BigInt toString a-z | function/dstr id-init-skipped | function/unscopables-with | do-while S12.6.1_A2 |
| --- | --- | --- | --- | --- | --- |
| base | pass | pass | pass | pass | pass |
| base + `JS2WASM_TEST_FORCE_MODULE_INIT_PASS2=1` | **pass** | **pass** | **pass** | **pass** | **pass** |
| candidate | fail | fail | fail | fail | fail |
| candidate + `JS2WASM_TEST_DISABLE_MODULE_INIT_PRELIFT=1` | fail | fail | fail | fail | fail |
| candidate + `FORCE_MODULE_INIT_PASS2=1` (kill switch) | pass | pass | pass | pass | pass |

Two things fall out, and they are the whole diagnosis:

1. **Compiling the initializer in the pass-2 slot is not the problem** — row 2 is
   the two-pass build whose EMITTED init is pass 2's, compiled after the bodies,
   and it is green. What breaks is compiling it there with **no pass 1 having
   run**.
2. **The pre-lift is not the problem either** — row 4 turns the registrations off
   and the failures are identical. So no amount of widening or narrowing the
   closure inventory touches these clusters. The kill switch works (row 5).

### R3 — root cause per cluster, and WHICH collections mattered

The gap-6 census asked which of the 45+ `ctx` collections pass 1 mutates are
decision-changing for the bodies compiled between the passes, and answered
"exactly one, the closure binding family". **That is false in two independent
ways, and the census's own table is where each one hides.**

**Family A — `ctx.moduleGlobals` is shifted; a caller's captured copy is not.**
Clusters 1 (16 decodeURI/decodeURIComponent OOB traps), 2 in part, and the
`do-while` single. Reduced to 4 lines inside the runner's harness:

```js
var a = [1, 2];
var n = 0;
for (var j = a[0]; j <= 2; j++) { n = n + 1; }   // n === 4, expected 2
```

`compileForStatement` (`src/codegen/statements/loops.ts`, the module-global arm
of the for-head `var` declaration) reads `ctx.moduleGlobals.get(name)` into a
local, calls `compileExpression` on the initializer, and only THEN pushes
`{ op: "global.set", index }`. Compiling `a[0]` adds the bounds-check error
path's string constant, `addStringConstantGlobals` runs
`fixupModuleGlobalIndices`, and that fixup does its job perfectly: it shifts
`ctx.moduleGlobals`, every already-emitted `global.get/set` reachable from any
live body, and ~20 cached index maps. It cannot shift a number held in a local
variable of a caller that has not pushed its instruction yet. Measured in the
emitted WAT: the for-head writes `global.set 107` while every other reference to
the same variable in the same function reads `global.get 108`, so `a[0]` lands in
the PRECEDING global and `j` keeps its default. The same off-by-one writes an
`f64` into an `externref` slot on a neighbouring shape, which is
`global.set[0] expected type externref, found if of type f64` at
`WebAssembly.instantiate` — cluster 2's `invalid Wasm binary`.

This is a **pre-existing latent bug, not one gap-6a introduces**. Pass 1 masks it
by compiling the whole initializer once, which creates every string-constant
import the second compile would have needed, so the emitting compile inserts no
global mid-body and there is nothing to go stale. It deserves its own issue; the
pass-1 skip is what removes the mask. This is the sixth instance of the
staleness family already documented inside `fixupModuleGlobalIndices` (#2023,
#2001, #3032, #3933, #4648) — the first five all fixed a *cache*; this one is a
value in flight on the stack, which no fixup can reach.

**Family B — the bodies specialize against TYPES the initializer mints.**
Cluster 3, all 33 array-pattern parameter rows. Reduced to two lines inside the
harness:

```js
function f([w]) { return w; }
var r = f([7]);   // r === undefined
```

The two-pass build's `$f` opens with a `ref.test (ref 12)` arm against the tuple
struct that `f([7])`'s argument literal mints, unwraps it with `struct.get 12 0`
and is done. Pass 1 compiles `f([7])` before `$f`'s body, so that type exists
when the body asks. With pass 1 gone the body is compiled first, the arm is never
generated, and every remaining arm mis-handles what the initializer later hands
it — `w` reads `undefined`, or the iterator arm reports
`Cannot destructure 'null' or 'undefined'`, or `SameValue(«4», «7»)`.

The collection is the census's **"on-demand caches (order drift only)"** row —
`structMap` / `structFields` / `anonTypeMap` and `mod.types`. The census
classified them as re-mintable on demand, and for the INIT they are. They are not
re-mintable for a body compiled BEFORE the init: a `ref.test` against a type that
does not exist yet is not a cache miss, it is an arm that never gets emitted.
**No AST-level inventory can publish this family, because producing it is
compiling the initializer — that is what pass 1 is.** This is the finding that
decides the slice.

**Cluster 4 — `with` / `@@unscopables`, 8 rows.** Same route dependency (row 4 of
the matrix reproduces it with the registrations off), surfacing as
`null is not a function [in __module_init_chunk_0() ← __module_init]` on the
sync half and `count` = 2 instead of 6 on the async half. The shape is a
`globalThis[Symbol.unscopables] = { … }` computed member-set plus a `with` body,
and its lowering reaches `reserveMemberSetDispatch`, which is one of the
`addStringConstantGlobal` callers the fixup instrumentation caught inserting
globals mid-init — i.e. family A's signature (a function-valued global read as
`null`). **Stated as a classification, not a proof: this cluster was not reduced
to a minimal case.** It is not explained away and it is not fixed.

**Cluster 5 — the singles.** `do-while/S12.6.1_A2.js` (`illegal cast in
__module_init`) is family A by shape. `S13.2.2_A13.js` (`eval`-declared function
called from a constructor), the two `scope-*-param-rest-elem-var-close.js` null
dereferences and `unary-{minus,plus}/S11.4.{7,6}_A3_T5.js` (`-function(){}`
should be `NaN`) were **not reduced**; each is a distinct lowering that consumes
something the init mints. Recorded, not explained.

**Cluster 6 — not reproduced locally**, see R1.

**The five improvements are the same mechanism running the other way**:
`ary-ptrn-elem-ary-rest-init.js` × 3 and `dflt-obj-ptrn-rest-val-obj.js` gain a
pass because a DIFFERENT arm wins when the init's type is absent. A family that
moves rows in both directions is not a bug fix; it is an ordering accident.

### R4 — why the sample said zero

The first landing's runtime evidence was a 90-file runner-faithful sample with
71 passes and 0 status divergences. The merge group then measured 76 pass→other
against ~35,400 passes — a **0.21 %** rate. At that rate a 71-pass sample expects
**0.15** hits and shows zero with probability ≈ **86 %**. The sample did not
disagree with the merge group; it had no power to see it. The compile samples
(325 + 163) had less power still, because seven of the nine ill-typed modules
they covered are reported as successful compiles.

The operative lesson for this family: **a route that reorders when the
initializer compiles must be measured at a sample size set by the effect it is
looking for**, and with instantiation counted.

### R5 — the decision, and the measurement behind it

**Option (b): the default is flipped OFF; the inventory and the gate stay as an
opt-in seam.** Option (a) — a narrowed admission rule — was considered and
rejected on the measurement, not on taste:

- Every regressing population is ADMITTED (87/87), so the narrowing would have to
  add refusals, not tighten existing ones.
- Family B has no syntactic marker short of **"the population contains a
  top-level function declaration whose body is compiled between the passes and is
  called from the initializer"**. The runner-faithful harness prelude alone
  contributes `function Test262Error`, `function $DONE` and the `assert` family
  to **325/325** sampled populations, and the test bodies call them. A
  fail-closed rule for family B therefore admits **0** of the harness corpus,
  which is the corpus the slice exists to serve.
- The alternative — enumerating the syntactic markers of the six observed
  clusters — is fitting the gate to the failures we happened to find. That is
  precisely the move that produced this incident: the first landing already
  carried one such mixed-population residual risk as "recorded, not asserted
  away", and it is one of the clusters above.

So the honest rule leaves admission at zero on the population that matters, and
the pre-lift's premise is wrong in family B. Both of the brief's triggers for (b)
are met.

**What ships:** `planModuleClosurePreLift` / `moduleInitDiscoveryIsStatic` /
`applyModuleClosurePreLift`, the `module-init-prelift` and
`module-init-discovery-static` counters, and the full suite — all inert unless
`JS2WASM_ENABLE_MODULE_INIT_DISCOVERY_STATIC=1`. `compileDeclarations` keeps the
`pass1DiagnosticMark` in its historic position on the default route and takes it
early only under the seam, so the (#4195) dedupe window is unchanged for every
build that does not opt in.

### R6 — verification

- **Runtime, runner-faithful, instantiation counted.** All 87 cited files,
  default route vs the base tree: **87/87 at status parity, 0 divergences.** Every one of the 76 pass→fail rows
  is back at `pass`.
- **Byte neutrality of the default route.** 341-file sample drawn across the
  required globs (`test/language/statements/**/dstr/**`,
  `test/built-ins/{decodeURI,decodeURIComponent,encodeURI,encodeURIComponent}/**`,
  `test/built-ins/Temporal/Duration/**`, all 8
  `test/language/statements/*/unscopables-with*.js`), assembled by
  `assembleOriginalHarness` and compiled with the runner's options on both trees,
  compared by sha256 of the emitted binary (successes) or of the sorted
  diagnostic set (failures): **341/341 identical** on the host lane (328 successful compiles sha256-identical, 13 compile-failure rows identical by sorted diagnostic set) and **120/120 identical** on the standalone lane over the first 120 files of the same sample.
- **Under the seam, the route still does what it claims.** The
  `issue-3523-module-init-discovery-static` suite runs every existing case with
  the seam ON, and gains two: `(g)` pins that the default is off (every admitted
  shape reads `pre-lift = 0, pass1 = 1` on all four lanes and still reads its
  value), and `(g) WHY it is off` turns two runner-faithful files — one per
  family — from `pass` to not-`pass` by setting the seam, so "this is why the
  default moved" is a mutation rather than a paragraph.
- **Pins that no longer move.** `tests/issue-3523-module-init-single-pass.test.ts`
  is restored byte-for-byte to its pre-slice state: with the route off, gap-1b's
  `1/0` and `1/1` censuses are the truth again, so the `Shape.discoveryStatic`
  flag and the two gap-6a-refused witness shapes the first landing added are
  gone. Byte identity across the pass-1 skip is still NOT a metric — under the
  seam the initializer compiles in a different slot and on-demand indices reorder
  by design.
- Suites, gates and ratchets: see the PR body.

### R7 — follow-ups this record hands on

1. **The `compileForStatement` stale-index bug is real on `main` today** and
   needs its own issue: a for-head `var` at module scope captures its
   module-global index before compiling the initializer expression and pushes the
   `global.set` after it. It is unreachable through the two-pass route, so it
   costs nothing today; it will bite any future change that moves work out of
   pass 1. The fix is one line — re-read `ctx.moduleGlobals.get(name)` after
   `compileExpression` — and it is a no-op whenever no shift happened. It is
   deliberately NOT in this PR: a repair PR whose whole point is byte-neutrality
   by default should not also change emitted code.
2. **The gap-6 census needs its "order drift only" bucket re-read.**
   `structMap` / `anonTypeMap` / `mod.types` are order-drift-only for the
   initializer and decision-changing for anything compiled before it. Any future
   pass-1 retirement has to answer family B first.
3. **Sample-size discipline for this family**: size the runtime sample to the
   effect (0.2 % of passes), count instantiation as part of success, and prefer
   an A/B on the FULL required globs over a spread sample when the change
   reorders compilation.
