---
id: 3523
title: "IR-only R4: typed ordered module-init compile-once ownership"
status: in-progress
sprint: current
created: 2026-07-21
updated: 2026-08-31
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
  - src/codegen/declarations/module-init-call-free.ts
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
func-budget-allow:
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
