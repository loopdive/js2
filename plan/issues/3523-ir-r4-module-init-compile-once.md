---
id: 3523
title: "IR-only R4: typed ordered module-init compile-once ownership"
status: in-progress
sprint: current
created: 2026-07-21
updated: 2026-08-12
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
  - src/codegen/index.ts
  - src/codegen/ir-prepared-free-functions.ts
  - src/codegen/context/types.ts
  - tests/issue-3523-ir-module-init-compile-once.test.ts
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
