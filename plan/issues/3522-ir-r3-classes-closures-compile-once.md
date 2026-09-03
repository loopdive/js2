---
id: 3522
title: "IR-only R3: compile-once classes, members, and closures"
status: in-progress
sprint: current
created: 2026-07-21
updated: 2026-08-29
assignee: ttraenkler/codex
branch: codex/3522-f2-owner-aware-direct-calls
priority: critical
horizon: xl
complexity: XL
feasibility: hard
reasoning_effort: max
task_type: refactor
area: ir, codegen, classes, closures
language_feature: compiler-internals
es_edition: multi
goal: ir-full-coverage
lane: ir-retirement-r3
model: gpt-5.6-sol
parent: 3518
depends_on: [3521]
required_by: [3523, 3525, 3527]
related: [1370, 1983, 2857, 2951, 3000, 3045, 3144, 3518]
origin: "#3518 R3 — extend PreparedIrProgram from free functions to every single-source executable class/closure unit"
files:
  - .github/workflows/test262-sharded.yml
  - .github/workflows/refresh-baseline.yml
  - src/ir/identity.ts
  - src/ir/class-accessor-safety.ts
  - src/ir/class-field-call-planning.ts
  - src/ir/class-instance-initializers.ts
  - src/ir/builder.ts
  - src/ir/extern-support.ts
  - src/ir/program.ts
  - src/ir/prepare.ts
  - src/ir/nodes.ts
  - src/ir/select.ts
  - src/ir/from-ast.ts
  - src/ir/integration.ts
  - src/ir/integration-identity.ts
  - src/ir/select-identity.ts
  - src/ir/passes/constant-fold.ts
  - src/ir/prepared-closure-support.ts
  - src/ir/prepared-component-dependencies.ts
  - src/ir/prepared-component-sealing.ts
  - src/codegen/class-bodies.ts
  - src/codegen/class-callable-abi.ts
  - src/codegen/class-field-layout.ts
  - src/codegen/function-body.ts
  - src/codegen/class-constructor-wrapper.ts
  - src/codegen/closures.ts
  - src/codegen/declarations.ts
  - src/codegen/ir-overlay-safety.ts
  - src/codegen/ir-overlay-identity.ts
  - src/codegen/ir-imported-call-planning.ts
  - src/codegen/ir-plain-implicit-constructors.ts
  - src/codegen/ir-prepared-free-functions.ts
  - src/codegen/ir-overlay-outcomes.ts
  - src/codegen/ir-class-shapes.ts
  - src/codegen/program-abi-class-callable-planning.ts
  - src/codegen/program-abi-session.ts
  - src/codegen/program-abi-type-planning.ts
  - src/codegen/context/types.ts
  - src/codegen/index.ts
  - scripts/ir-only-baseline.json
  - plan/log/ir-optimization-retirement-ledger.md
  - tests/class-expressions.test.ts
  - tests/issue-3214-callable-abi.test.ts
  - tests/issue-2859.test.ts
  - tests/issue-3522-ir-nested-class-expression-ownership.test.ts
  - tests/issue-3522-ir-nested-class-ownership.test.ts
  - tests/issue-3522-nested-class-field-call-planning.test.ts
  - tests/issue-3522-nested-class-field-call-admission.test.ts
  - tests/issue-3522-nested-class-field-call-marker.test.ts
  - tests/issue-3520-ir-first-identity.test.ts
  - tests/issue-3520-ir-unit-identity.test.ts
  - tests/issue-3520-planning-owner.test.ts
  - tests/issue-3520-inherited-class-integration-abi.test.ts
  - tests/issue-3521-prepared-free-function-routing.test.ts
  - tests/issue-3521-prepared-component-dependencies.test.ts
  - tests/issue-3522-ir-class-compile-once.test.ts
  - tests/issue-3522-ir-cross-owner-free-function.test.ts
  - tests/issue-3522-ir-object-method-call-ownership.test.ts
  - tests/issue-3522-ir-static-class-method.test.ts
  - tests/issue-3522-test262-shard-completion.test.ts
  - tests/test262-shared.ts
  - tests/issue-3792-ir-optimization-retirement-gate.test.ts
  - tests/issue-4102-program-abi-closure-support.test.ts
loc-budget-allow:
  - src/codegen/class-bodies.ts
  - src/codegen/declarations.ts
  - src/codegen/index.ts
  - src/codegen/ir-prepared-free-functions.ts
  - src/codegen/program-abi-session.ts
  - src/codegen/program-abi-type-planning.ts
  - src/ir/builder.ts
  - src/ir/from-ast.ts
  - src/ir/integration.ts
  - src/ir/module-bindings.ts
  - src/ir/nodes.ts
  - src/ir/prepared-closure-support.ts
  - src/ir/prepared-component-dependencies.ts
  - src/ir/select.ts
  # 2026-08-28 (F4). Measured against origin/main 81e54a98e: the admitted-class
  # marker adds +120 LOC to `identity.ts` (1471 -> 1591) and +146 to
  # `select-identity.ts` (1463 -> 1609), pushing both across the 1500-LOC
  # god-file threshold for the first time. The marker's container, its
  # authenticity check and the two threading helpers belong with the identity
  # records they key on; its proof-consuming derivation belongs with the
  # selector that consumes it. Splitting either into a new module would put the
  # marker type on the wrong side of the identity/selection seam and force a new
  # ir->ir import edge for every one of the seven consumers.
  - src/ir/identity.ts
  - src/ir/select-identity.ts
func-budget-allow:
  - src/ir/select.ts::isPhase1Expr
  - src/codegen/class-bodies.ts::collectClassDeclaration
  - src/codegen/declarations.ts::compileDeclarations
  - src/codegen/function-body.ts::compileFunctionBody
  - src/codegen/index.ts::buildIrClassShapes
  - src/codegen/index.ts::generateModule
  # 2026-08-28 (F4). Measured against origin/main 81e54a98e: 628 -> 652 (+24).
  # F4 requires the ONE resolver, the F3 proof and the derived admitted-class
  # marker to be constructed here, before local class-expression resolution and
  # identity selection, and then handed to five call sites in the same
  # function. Hoisting them out would either recompute the marker per consumer
  # (the exact thing the slice forbids) or make it a mutable sidecar.
  - src/codegen/index.ts::planIrOverlay
  - src/ir/from-ast.ts::lowerFunctionAstToIr
  - src/ir/from-ast.ts::lowerMethodCall
  - src/ir/integration.ts::compileIrPathFunctions
  - src/ir/integration.ts::makeFromAstResolver
  - src/ir/prepared-component-dependencies.ts::collectFunctionEvidence
  - src/ir/select-identity.ts::planIrCompilationByIdentity
  - src/ir/select.ts::isPhase1StatementListInScope
  - src/ir/select.ts::whyNotIrClaimable
---

# #3522 — IR-only R3: compile-once classes, members, and closures

## Objective

Extend R2's prepare-before-emit ownership from top-level free functions to the
complete executable-unit census of an ordinary single-source program:

- class declarations and class expressions;
- explicit/default constructors;
- instance and static methods;
- instance and static getters/setters;
- instance field initializers and constructor parameter/default work;
- inheritance, `super`, inherited aliases, and class support wrappers;
- nested function declarations, function expressions, arrows, object methods,
  and every lifted closure body/trampoline/cache unit.

Every source body is Prepared and IR-emitted once or typed Unsupported and
direct-emitted once under the temporary hybrid policy. No class/member/closure
may be selected, silently skipped by integration, compiled direct, and then
patched.

## Current evidence

Class integration still depends on direct compilation as its ABI producer:

- `src/ir/select.ts:591-616` inventories constructors, instance methods, and
  static methods under legacy synthetic names. The comment still describes a
  selector-only/patch-later model.
- `src/ir/select.ts:700-705` explicitly admits ordinary static methods, but
  `src/ir/integration.ts:396-411` skips every static member. This is a concrete
  claimed-without-integration hole that a fallback histogram can miss.
- `src/ir/integration.ts:280-297` says class members and module init target
  legacy-preallocated slots. At `:393-445` it finds a class/member by flat
  display name, and at `:943-970` a type mismatch keeps the direct body.
- `src/codegen/class-bodies.ts:595-1465` combines class identity/layout/ABI
  planning with placeholder registration, inherited aliases, descriptors,
  static globals, and static-init queue mutation.
- `src/codegen/class-bodies.ts:1551-1740` then compiles constructor/default/
  field work directly. The source constructor body is split across
  generated `${Class}_new` and `${Class}_init` functions
  (`:1043-1075`, `:1642-1692`). Those support units are not represented in the
  current `IrModule` contract.
- `src/codegen/declarations.ts:1872-2074` recursively eager/deferred-compiles
  class declarations/expressions. Capturing nested classes are routed through
  separate in-scope paths; a pre-emission unit inventory does not yet own that
  decision.
- `src/ir/from-ast.ts:537-545` can return lifted functions, but their identity,
  ABI slots, and failure are attached after the parent build. A lifted failure
  can therefore demote a parent only after other legacy effects exist.

R3 splits class/closure planning from body emission and makes every hidden
support unit visible to `PreparedIrProgram`.

## Static-method production slice (2026-08-02)

The selector/integration mismatch for ordinary static methods is closed.
Static methods lower as class-owned, no-receiver IR functions; exact owner
projection, terminal evidence, and outcome reconciliation now include them.
Their allocated class-callable handles survive pre-direct function-record
replacement, and dependency-complete static components can seal through the
same Program ABI transaction as free functions.

For a sealed static component, `compileClassBodies` receives an exact requested
skip projection, preserves the already installed IR body, and reports the
physical class slot back for unit-ID correlation. The shared audit proves every
skipped class slot has one patched terminal result. Unsealed static probes are
removed from the early report, compile direct, and run through the established
late overlay; they do not produce duplicate terminal evidence. Instance
methods, constructors, accessors, fields, and closures remained on that
transitional route at this slice.

Focused runtime coverage proves:

- numeric static methods on `gc` and `standalone` have no synthetic `self`,
  emit no legacy body, validate as Wasm, and return the expected value;
- same-named static overrides on separate structural class owners retain
  distinct slots and runtime behavior; and
- an adjacent Unsupported instance method in a separate class still emits its
  direct body, preventing a source-wide or flat-name skip from satisfying the
  test.

The authoritative single-host lane moves from **31 to 33 IR-emitted units**,
from **6 to 4 Unsupported units**, and from **37 to 35 legacy bodies**, with
zero invariants. The remaining Unsupported units are two async functions, one
async-body shape, and one call-graph closure. Hybrid is READY; strict IR-only
is still NOT READY because 35 units retain legacy bodies.

This is the first bounded R3 production slice, not issue completion. The
no-receiver static ABI is preserved, but constructors, accessors, field work,
inheritance support, class expressions, nested units,
object methods, and closures still need component-atomic prepare/emit ownership
and optimization-parity evidence before their direct handlers can retire.

## Flat instance-method production slice (2026-08-02)

Ordinary instance methods on exact top-level class declarations without an
`extends` clause now join the pre-direct class-method preparation pass when the
method contains no nested executable syntax and the already-collected class
layout is index-stable and scalar. Scalar here is a structural contract: the
layout has no parent edge and every field is `i32`, `i64`, `f32`, `f64`,
`v128`, `i8`, or `i16`. Reference-bearing layouts stay on the established late
route because their physical type indices may move during compaction. The
eligible layout is published into Program ABI before IR integration, and the
exact `class-layout` binding is included in the prepared component scope before
it seals. This keeps the receiver ABI and class callable handle immutable
before any class body emitter can run.

Methods that depend on the same canonical class-layout binding are unioned into
one atomic prepared component. `compileClassBodies` skips only the exact sealed
ordinary-method slots, preserves the installed IR bodies, and reports their
physical handles for terminal reconciliation. Constructors and accessors remain
direct, as do Unsupported instance methods; the direct emitter and its existing
optimizations are unchanged for those paths. A verifier Invariant is terminal
and cannot retry the direct body emitter.

Focused `gc` and `standalone` coverage proves:

- two instance methods on the same flat class each record `direct=0, IR=1` and
  share one prepared component ID, so omitting class-layout ownership or
  component union cannot satisfy the test;
- a default-parameter method on a separate string-field class records
  `direct=1, IR=0`; a direct structural-policy test rejects its `ref_null`
  layout, while the combined program validates as Wasm and returns the expected
  runtime value; and
- an injected verifier failure records one Invariant with `direct=0, IR=0`,
  proving there is no post-claim legacy retry.

The authoritative single-host readiness corpus is unchanged before versus
after this bounded slice: **37 terminal units, 33 IR bodies, 35 legacy bodies,
4 Unsupported, and zero Invariants** on both `origin/main` and this branch.
None of its five entries contains an eligible scalar-layout instance method;
the physical ownership improvement is therefore measured by the focused
per-unit counters above rather than an artificial corpus change. Hybrid remains
READY, while strict IR-only remains NOT READY with the same four typed async /
closure blockers and 35 retained legacy bodies.

Reference-bearing class layouts, constructors, accessors, fields,
derived/inherited classes, class expressions, nested class units, object
methods, and closures remain for later R3 slices.

## Bounded class method/accessor checkpoint (2026-08-03)

The final-async checkpoint #4065 leaves the authoritative single-host lane at
**37/37 IR-emitted**, **30 legacy bodies**, **0 Unsupported**, and **0
Invariant**. Ten terminal units are class members. The two static bodies
`Animal_kingdom` and `Dog_kingdom` already compile once through Prepared IR.
This checkpoint retires the next six source bodies:

| Component | Source unit       | Kind                | Prepared dependencies                            |
| --------- | ----------------- | ------------------- | ------------------------------------------------ |
| Animal    | `Animal_get_name` | instance getter     | receiver layout and native-string field carrier  |
| Animal    | `Animal_set_name` | instance setter     | receiver layout and native-string field carrier  |
| Animal    | `Animal_get_age`  | instance getter     | receiver layout and native `f64` field carrier   |
| Animal    | `Animal_speak`    | instance method     | receiver layout, private read, string concat      |
| Dog       | `Dog_speak`       | overriding method   | inherited layout, direct `super.speak`, concat    |
| Dog       | `Dog_get_breed`   | instance getter     | inherited layout and native-string field carrier |

`Animal_new` and `Dog_new` remain direct in this checkpoint. Constructor
retirement is not another method-shaped skip: the current IR constructor
overlay owns `_new`, while the direct backend executes the source constructor
inside `_init` and `Dog_init` calls `Animal_init`. Retiring those bodies safely
requires one source-constructor unit lowered into `_init`, plus an AST-free
allocation-and-init `_new` support wrapper. That `_new`/`_init` ownership
transaction is the first item in the handover below.

### Preparation and deletion contract

1. Replace the scalar-only early class-layout gate with Program-ABI-owned
   preparation of reference-bearing and inherited class layouts. Every parent
   and field type index follows structural remapping; a prepared class draft is
   refreshed after exact type compaction and reported leaf finalization.
2. Prepare top-level instance methods, getters, and setters through the same
   exact structural owner projection. `compileClassBodies` skips only sealed
   bodies and never inspects their AST; an injected direct-body poison proves
   the six names stay outside the legacy emitter, with `Animal_new` as the
   positive control.
3. Delete the obsolete scalar-layout-only preparation API and method-only
   naming in the same checkpoint. Constructors retain their measured direct
   implementation until the `_new`/`_init` transaction proves one source-body
   owner and can delete it.
4. Bank only a freshly measured reduction from **30 to 24 legacy bodies**.
   The result must remain **37/37 IR-emitted**, **0 Unsupported**, and **0
   Invariant**. Eight class-member terminals then have `legacyBodyEmitted:
   false`; only `Animal_new` and `Dog_new` remain legacy-backed in that family.
   Strict IR-only remains red solely on 20 free functions, two module-init
   bodies, and those two constructors.

### Optimization-parity contract

- Preserve one typed class receiver for every method/accessor, with no dynamic
  receiver box, ambient-`this` frame, or generic member ladder. `Dog_speak`
  retains the direct backend's single static parent narrowing at the
  `Animal_speak` ABI boundary and does not add a `ref.test` dispatch ladder.
- Preserve private-field `struct.get`/`struct.set` lowering, native `f64` age,
  and native-string field carriers. No `__extern_get`, `__extern_set`, dynamic
  member ladder, or string box/unbox round trip may appear in the six bodies.
- Preserve one direct symbolic `Animal_speak` target from `Dog_speak`, the
  existing class-tag/subtype layout, and owned/native string concatenation.
- Record typed class receivers, private class fields, and direct super calls in
  the optimization-retirement ledger. Runtime and WAT evidence are verified;
  performance attribution stays pending under #3792 before deleting the
  corresponding direct optimization globally.

### Required anti-vacuity evidence for this checkpoint

- Pin all ten class-member telemetry rows and the exact six-body delta; a
  summary count without names is insufficient.
- Run the unchanged playground classes entry in the GC lane and assert the
  complete console trace: accessors, field mutation, override/super ordering,
  `instanceof`, and static results. Compile and validate both GC and standalone.
- Compare direct-control and prepared WAT shapes for typed receiver, private
  field, super-call, and string-concat operations. The prepared output may not
  replace those with generic host/member traffic.
- Activate the direct-body poison seam for all six prepared names and prove the
  constructor positive control fails.
- Keep focused #3520/#3521/#3522 class identity, callable, remap, inheritance,
  funcMap collision, and selector-preclaim suites green. Pass hybrid readiness,
  expected strict IR-only failure solely on 24 named bodies, fallback/shape,
  optimization-retirement, allocation provenance, typecheck, formatting,
  cross-backend/equivalence, and full merge-group Test262 gates.

### Handover after this checkpoint

Checkpoint result: hybrid shadow validation measures **5/5 entries, 37/37
IR-emitted terminals, 24 legacy bodies, 0 Unsupported, and 0 Invariant**. The
six retired names are `Animal_get_name`, `Animal_set_name`, `Animal_get_age`,
`Animal_speak`, `Dog_speak`, and `Dog_get_breed`; each records
`legacyBodyEmitted: false` and `irBodyEmitted: true` on GC and standalone. The
strict IR-only shadow remains red only because these exact bodies remain:

- constructors: `Animal_new`, `Dog_new`;
- module init: `calendar.ts::<module-init>`, `algorithms.ts::<module-init>`;
- calendar functions: `el`, `mname`, `dimOf`, `fdow`, `priceOf`, `renderCal`,
  `onDay`, `updFoot`, and `main`;
- algorithms functions: `fibIter`, `fibMemo`, `binarySearch`, `quicksort`,
  `joinNums`, and `main`;
- builtins functions: `el`, `crd`, `rw`, and `main`;
- classes function: `main`.

The production branch is `codex/3522-class-member-retirement` in the isolated
worktree `/private/tmp/ts2wasm-3522-class-member-retirement`, published as
ready PR [#4081](https://github.com/loopdive/js2/pull/4081). The branch was
rebased onto `origin/main` immediately before the final handover push and is
not queued at suspension. The dirty root checkout is not part of this work.

### PR #4081 equivalence repair (2026-08-03)

The first PR run exposed four genuine branch regressions: the derived class
without an explicit constructor and three inherited/private-field programs.
Each passed alone on the detached `origin/main` control and failed alone on the
published head. All four had the same failure: dependency discovery sealed the
exact ancestor class-member unit, but Phase 3 ignored the `class.call` target
already carried by IR and attempted to mint a child-name inherited adapter
after that component was immutable.

The Phase 3 class resolver now binds dependency-sealed class-operation unit
targets into each lowering pass and uses those same targets for instance,
`super`, and static calls. The inherited adapter remains only for compatibility
IR without a structural target. Added GC/standalone coverage poisons both the
ancestor and derived direct emitters,
requires both class bodies to remain Prepared IR, validates the module, and
checks the inherited runtime result. The four CI regression cases pass alone;
the complete private-field equivalence file and focused #3000/#3520/#3521/#3522
suites pass. This repair changes no terminal ownership or readiness counts:
**37/37 IR-emitted, 24 legacy bodies, 0 Unsupported, 0 Invariant**.

Final-head validation before publication:

- focused prepared routing and class retirement: **42/42 passed**;
- IR allocation registry/provenance: **16/16 passed**;
- typecheck, formatting, issue integrity, optimization retirement, fallback
  shape diagnostics, oracle, LOC/function budgets, vacuity shapes, and
  equivalence gates passed;
- hybrid shadow: **37/37 IR, 24 legacy, 0 Unsupported, 0 Invariant**;
- strict IR-only shadow: expected red on exactly 24 legacy bodies;
- `check:linear-ir` had a pre-existing then-current-main ratchet failure
  (`compiled 8 -> 6`, two `vec.set_length` and two string-builder demotions).
  The identical result was reproduced in a clean detached `origin/main`
  worktree at `f23ea5025e04ac`; this checkpoint does not refresh that unrelated
  baseline.

### Explicit-constructor source-body checkpoint (2026-08-09)

The two bounded WasmGC constructors now compile once. The terminal/reporting
identity remains `Animal_new` / `Dog_new`, but physical ownership is no longer
ambiguous:

- `_init(sourceParams..., self) -> self` is the exact constructor source-unit
  callable and the only function that contains source field writes, defaults,
  and `super(...)` semantics;
- `_new(sourceParams...) -> self` is a class-owned support callable containing
  only default/tag allocation, one `struct.new`, argument forwarding, and one
  `return_call` to the exact `_init`; and
- `class.new` records both dependencies. Dependency sealing follows the
  `_new` support binding and the `_init` source unit, while lowering consumes
  those same exact targets. The constructor source component also pins its own
  `_new` support binding even though `_init` contains no `class.new`
  instruction. A derived init records the parent `_init` unit and passes the
  same receiver.

The wrapper is installed from stable Program ABI handles before the prepared
component seals. `compileClassBodies` skips the source constructor before its
direct body emitter/poison seam; it preserves the prepared `_init` and the
already-installed wrapper. Generic direct `_init` compilation remains for
constructors that are not yet eligible. In particular, conditional, late, or
repeated `super()`, externref-backed classes, parameter properties, property
initializers, implicit constructors, unresolved forward-class parameter ABIs,
and constructor calls or accessor operations reached through `this`/`super`
stay direct with typed telemetry and no post-claim demotion. The receiver
dispatch families remain direct until IR can preserve virtual method and
getter/setter dispatch rather than statically binding the constructor owner.

The obsolete allocation-owning IR constructor model was deleted in this same
checkpoint: `constructorClassShape`, `class.alloc`, `emitClassAlloc`,
`IrClassLowering.allocInstrs`, the duplicate integration allocation prefix,
and the old `class-constructor-init` support role have no remaining production
or test consumer. The shared AST-free wrapper is now the single allocation
implementation used by both prepared and generic-direct init bodies.

Executable parity and output-shape coverage in GC and standalone proves:

- direct constructor-body poison is never entered for `Animal_new` or
  `Dog_new`, while unsupported constructor controls still enter it;
- one allocation occurs in each `_new`, source `struct.set` operations occur
  only in `_init`, and `Dog_init` calls `Animal_init` once on the same receiver;
- private fields retain native string carriers and unboxed `f64`, with no
  ambient-`this`, dynamic-member, boxing, or indirect-call ladder; and
- receiver method calls and getter/setter accesses execute through the direct
  dispatch path with their observable virtual/accessor behavior intact.

Separate routing-only controls prove that unsafe-super, externref-backed, and
forward-class-ABI constructors remain direct and still reach the direct-body
poison seam. Those controls compile and validate but do not execute the
constructor, so they are not runtime-parity claims.

Fresh readiness measurement is **5/5 entries, 37/37 IR-emitted terminals, 22
legacy bodies, 0 Unsupported, and 0 Invariant**. Hybrid is READY. Strict
IR-only is expected red solely on those 22 bodies: the same 20 free functions
and two module-init bodies listed in the prior handover, with `Animal_new` and
`Dog_new` removed. The constructor family therefore moves from **24 to 22**
legacy bodies without changing the 37-unit denominator.

1. Retire `Animal_new` and `Dog_new` by making `_init` the sole source-body
   owner and `_new` an AST-free allocation wrapper; retain same-receiver
   `Animal_init` chaining and delete the obsolete allocation-owning IR path.
   **Completed by the 2026-08-09 checkpoint.** Generic direct `_init`
   compilation intentionally remains for the unsupported constructor shapes
   named above.
2. Retire closures and cross-owner calls as one family, then module
   initialization, then runtime/linear-memory helpers. Keep only one
   overlapping production PR active. The class-member selector intentionally
   leaves a member with a structural edge to a top-level free function direct
   until that family can prepare both owners atomically.
3. For each family, reduce the measured legacy count, pass hybrid plus strict
   shadow validation, add semantic/output-shape optimization parity, and delete
   the obsolete legacy implementation in the same PR when no consumers remain.

### Published checkpoint handover

Ready PR [#4268](https://github.com/loopdive/js2/pull/4268) publishes
`codex/3522-constructor-retirement` from the isolated worktree
`/private/tmp/ts2wasm-3522-constructor-retirement`. The production checkpoint
is `2cdd8116f8b2a74cabee54fb4d6b7019f53dafe6`, rebased onto `origin/main`
`6a16f225cb6aa36645375de4a2d35b2170f9937e`. The PR is intentionally ready,
not draft, and is not in the merge queue at suspension. Do not modify the
branch after it enters the queue; full Test262 remains merge-queue-only. The
dirty root checkout is outside this worktree and remains untouched.

Final post-rebase evidence:

- changed-root regressions: **80/80 passed**;
- constructor/dependency focus: **52/52 passed**;
- main-overlap closure `$bag`, derivation-default, and eval/finally controls:
  **47/47 passed**;
- the exact async IR-only shadow passes with its direct-body poison and firing
  control, and the #4102 Program ABI closure fixture now carries main's
  canonical `[func, $arity, $bag, ...captures]` header;
- typecheck, formatting, normal fallback, zero-attributed shape diagnostics,
  hybrid readiness, allocation provenance, issue integrity, adoption,
  optimization retirement, LOC/function budgets, vacuity-shape, oracle, and
  verdict gates pass; and
- strict IR-only is expected red only on 22 legacy bodies. The linear ratchet
  is separately red with the identical result on this branch and clean
  `origin/main` at `5cb2d525`: compiled `8 -> 6`, two
  `illegal:instr-vec.set_length`, and two `select:string-builder-candidate`
  demotions. This checkpoint does not refresh that unrelated baseline.

Resume only after #4268 lands or is explicitly withdrawn. The next production
transaction is closures and cross-owner calls; keep receiver-derived
constructor method/accessor dispatch gated until its two incomplete
optimization-ledger rows have semantic and output-shape IR ownership.

### Cross-owner free-function checkpoint (2026-08-09)

PR #4268 landed on `main` at `464858cfe98e30af7170486bd55131b4ec8bd229`.
The first cross-owner retirement slice then replaced the split free-function /
class-member preparation passes with one exact transaction. That transaction
projects one combined lowering plan, compiles once, seals against the union of
free-function and class-member claims, routes/defer-checks the combined report
once, and only then partitions the skip/preserve views used by the two legacy
declaration seams. A routing unit that belongs to neither or both families is
a hard invariant. Class layouts are published from final post-pass IR rather
than before the combined free-function build can finalize their allocator-owned
structs. When one owner still fails dependency sealing, only that exact owner
is peeled and the remaining denominator is rederived; a blocked caller no
longer withdraws an otherwise complete callee, and no body is compiled twice.

Equivalence qualification exposed one additional transaction boundary: a
component with both a preparable class layout and a hard direct-route blocker
must not publish the mutable allocator layout before it is peeled. Immutable
callable imports/providers now preflight first while tolerating only proven
preparable class blockers. A class layout is published only after it is the
component's complete remaining blocker set. The explicit dynamic-`super`
control proves the blocked child and its free caller keep their direct behavior
and poison seam without leaving a stale ABI draft, while an independent parent
method can still seal on IR.

This closes the free-function-to-class direction for the bounded WasmGC class
program. `classes.ts::main` and all ten Animal/Dog constructor, method, and
accessor terminals now share one prepared component ID and record
`legacyBodyEmitted: false`, `irBodyEmitted: true`. The reverse direction stays
conservative: a class member that calls a top-level free function remains on
the direct component until that complete family is owned atomically. Module
globals also remain deferred.

Explicit parity evidence now proves:

- the exact nine-line Animal/Dog runtime trace and ordered direct class-call
  target sequence;
- one specialized numeric-to-string call, nine typed string-log calls, and
  eight string concatenations without dynamic boxing;
- the exact Dog and Animal static tag-test shapes for `instanceof`; and
- absence of `call_ref`, `call_indirect`, `ref.test`, dynamic extern class
  dispatch, ambient `this`, argc, and arguments traffic in prepared `main`.

The same maximal sealing transaction independently retires Algorithms
`fibIter`. Its exact playground run preserves all 20 output lines, and its WAT
retains `f64` loop-carried `a`/`b`, an `i32` counter slot, one loop, and no
call, boxing, or extern-carrier traffic. `fibMemo`, binary search, quicksort,
`joinNums`, Algorithms `main`, and its module initializer remain direct.

Standalone `classes.ts::main` remains an explicit selector-unsupported ambient
console boundary. Its ten class terminals are still IR-only, and an in-Wasm
trace sink proves the unchanged direct-main behavior. A default-parameter
constructor control proves selector-rejected class dependencies and their free
owner remain direct and still reach the direct-class-body poison seam.

Fresh hybrid shadow validation is **5/5 entries, 37/37 IR-emitted terminals,
20 legacy bodies, 0 Unsupported, and 0 Invariant**. This checkpoint reduces
the measured ceiling from **22 to 20** without changing the denominator.
Strict IR-only remains expected-red solely on these bodies:

- Calendar: module initializer plus nine functions (**10**);
- Algorithms: module initializer plus five functions (**6**);
- Builtins: four functions (**4**); and
- Classes: **0**.

No dedicated legacy implementation is deleted in this slice: `main` uses the
shared free-function direct emitter, which still has 18 measured consumers.
Deleting that shared implementation now would remove live fallback behavior;
its deletion belongs to the final free-function-family retirement that proves
zero consumers. The resumable branch is
`codex/3522-cross-owner-retirement` in
`/private/tmp/ts2wasm-3522-cross-owner-retirement`; the dirty root checkout is
outside it and remains untouched.

### Published cross-owner handover

Ready PR [#4281](https://github.com/loopdive/js2/pull/4281) publishes this
checkpoint. It was rebased after overlapping PR #4258 landed and requalified
without conflict on `origin/main` at
`517aa2d0debef17373eeadf36d42a775e4c6ddce`. The red checkpoint, production
transaction, and stale-layout repair commits are respectively
`c55f7cc9c4e978`, `fd198e02b47276`, and `5add835c833d99`.

Post-rebase qualification is green: changed-root **49/49**, focused
cross-owner/inherited/`super` parity **28/28**, all four equivalence shards with
zero new regressions, typecheck, formatting, hybrid shadow, fallback, shape,
optimization, oracle, budget, vacuity, and issue-integrity gates. Strict
IR-only is expected red only on the exact 20-body census above. Full Test262 is
merge-queue-only. Do not modify the PR branch after it enters the queue.

Resume production only after #4281 lands or is explicitly withdrawn. The next
bounded overlapping family is the four-body Builtins closure/cross-owner
component (`el`, `crd`, `rw`, `main`); keep one production PR active and use
parallel agents only for disjoint inventory, parity, optimization audit, and
review work.

### Builtins externref-ABI checkpoint (2026-08-09)

PR #4281 landed at `b76cb519041494fcb28de69e6ec29bed58edafe4` with
full merge-group Test262 and equivalence qualification green. The next serial
transaction retires the four Builtins functions `el`, `crd`, `rw`, and `main`.
They now pass R2 selection with exact externref slot parity, lower to final IR,
and seal as one dependency-complete prepared component. Every DOM, Math,
number-format, and string provider is represented by an exact symbolic Program
ABI reference before sealing; lowering consumes that same reference.

Extern instructions no longer hide member dependencies behind compatibility
names. After the target-neutral runtime manifest freezes, a final
provider-attachment pass records exact imports for construction, method calls,
property reads, and property writes. It never mutates the semantic `asyncPlan`;
backend attachments may appear only in ordinary final IR or `asyncRuntime`.
Semantic extern class brands remain separate from lookup spellings and import
prefixes so namespace-owned classes such as `ListFormat` resolve
`Intl_ListFormat_new`, not `ListFormat_new`. RegExp literal IR intentionally
remains fail-closed: its constructor plus pattern/flags string storage
dependencies must be made explicit together in a later runtime family, not
partially admitted here.

The direct backend's three reachable Builtins optimizations now have explicit
IR owners and parity evidence:

- literal-only string concat chains fold to one `string.const` while preserving
  result, source-site, and allocation identity;
- exact immutable literal/const-chain `String.includes` calls fold to one
  boolean constant while mutable/dynamic/position-argument shapes retain the
  runtime method; and
- constant JS bitwise operations fold with result-aware signed-i32 versus f64
  unsigned semantics, including shift-count masking.

The unchanged full fake-DOM oracle proves all 81 elements, the 9/9/4/6 card
shape, all 24 values, every CSS string, and IR/direct equality. WAT evidence
pins the eight typed DOM imports, excludes generic extern dispatch and direct
body framing, requires zero fixed CSS concat calls, requires the immutable
includes result `i32.const 1`, and requires exact bitwise results
`65280/205/255/240/-1`. Dynamic negative controls keep the corresponding
runtime concat/includes/bitwise operations. A fresh uncached poison run proves
all four prepared names bypass `compileFunctionBody`, while an IR-disabled
ordinary function proves the seam is live.

Fresh hybrid shadow validation is **5/5 entries, 37/37 IR-emitted terminals,
16 legacy bodies, 0 Unsupported, and 0 Invariant**. This checkpoint reduces
the measured ceiling from **20 to 16** without changing the denominator.
Strict IR-only is expected red solely on:

- Algorithms: module initializer plus `fibMemo`, `binarySearch`, `quicksort`,
  `joinNums`, and `main` (**6**); and
- Calendar: module initializer plus `el`, `mname`, `dimOf`, `fdow`, `priceOf`,
  `renderCal`, `onDay`, `updFoot`, and `main` (**10**).

No shared direct implementation is deleted in this checkpoint.
`compileFunctionBody` still owns these 16 measured consumers and broader hybrid
coverage, so deleting it here would remove live fallback behavior. The next
single production transaction is the six-body Algorithms component together
with its module initializer under #3523. It must preserve Map lifetime,
recursion, vector/quicksort representation, the native i32 midpoint shift,
number formatting, string append, and exact 20-line output before banking
**16 → 10**. Calendar remains the final bounded **10 → 0** family.

The resumable production branch is `codex/3522-builtins-retirement` in
`/private/tmp/ts2wasm-3522-builtins-retirement`. The dirty root checkout is
outside it and remains untouched. Publish this branch as one ready PR, freeze
it once queued, and run full Test262 only through the merge queue.

### Class-to-free cross-owner checkpoint (2026-08-12)

The next serial R3 slice is implemented locally on
`codex/3522-general-classes-retirement` in
`/private/tmp/ts2wasm-3522-general-classes-retirement`, stacked on the ready
Calendar retirement PR #4395. Do not publish or rebase this branch until #4395
lands; it remains the only active IR production PR.

The old selector deliberately rejected every class member that called a
top-level free function even when both bodies had exact Program ABI identities
and were otherwise preparation-safe. R2 also closed only the free-function
candidate set, so the free callee was withdrawn because its class caller was
outside that set. The slice removes that obsolete family barrier and runs one
bidirectional call-ownership fixed point over the free-function and eligible
class-member candidates together. If either endpoint is unprepared, both still
withdraw before body emission; otherwise the existing combined dependency
sealer and exact AST-site call plans own the edge.

An exact `Counter.next -> increment` fixture measures the improvement. Before
the slice, `increment`, `Counter_next`, and `run` emitted legacy bodies while
`Counter_new` was already compile-once (**3 -> 0 legacy bodies across four
terminals**). After the slice, all four terminals report `direct=0, IR=1` on
both WasmGC and standalone. A direct-class-body poison on `Counter_next`
remains green, proving the old method emitter is not entered.

Optimization parity is explicit: the final IR still applies inline-small to
`increment`, so `Counter_next` contains the direct `f64.const 1; f64.add`
shape with no direct call, `call_ref`, or `call_indirect`. Because the final
post-pass IR has no callee edge after inlining, the independently complete
callee may seal separately while the constructor, method, and exported caller
share their class-layout component. The existing selector-rejected default-
parameter constructor remains a typed direct negative control. The same test
file now records the already-landed Algorithms component as zero legacy bodies
instead of preserving its obsolete pre-#3523 six-body snapshot.

The exact pre/post artifact comparison strengthens that parity claim. For the
same fixture, target, source name, and unoptimized compiler options, the
`Counter_next` WAT body hash is unchanged in both backends:

| Target | Before | After | Delta | `Counter_next` WAT |
| --- | ---: | ---: | ---: | --- |
| WasmGC | 1,068 bytes | 972 bytes | -96 bytes (-9.0%) | identical SHA-256 `6935d4c2...33446` |
| standalone | 46,283 bytes | 21,286 bytes | -24,997 bytes (-54.0%) | identical SHA-256 `08c8a32e...2b2d` |

The size decrease is the removed legacy-body/provider closure, not a weakened
hot path: both final method bodies retain the same typed struct read and direct
`f64.const 1; f64.add; return` sequence. The full focused R2/R3 matrix passes
**96/96**, alongside typecheck, formatting, IR-only, fallback, optimization-
retirement, issue-integrity, LOC-budget, and function-budget gates.

The removed cross-owner exclusion is itself obsolete production policy and is
deleted in this slice. General direct free-function and class body emitters
still have unsupported consumers (unsafe/conditional super, externref-backed
classes, forward class ABIs, nested executable owners, and dynamic member
families), so deleting those shared implementations here would be premature.
Those families remain the next R3 retirement work before generic R4/R5 can be
claimed complete.

### Plain implicit-constructor checkpoint (2026-08-12)

This checkpoint retires the top-level class family with no explicit
constructor, no instance initializer, and no heritage. Its implicit
`<Class>_new` / `<Class>_init` pair already has exact structural
`class-implicit-constructor` identity and Program ABI handles. Preparation now
installs the exact empty `_init(self) -> self` body and existing AST-free
allocation-plus-init `_new()` wrapper before dependency sealing. The Program
ABI treats this exact non-terminal callable as immutable prepared support only
after checking its inventory kind, terminal-owner absence, allocator identity,
signature, locals, and single `local.get 0` body. The direct class pass then
skips the same support UnitId and correlates that skip after emission.
The narrow `program-abi-session.ts` LOC allowance covers that central seal-time
provenance guard; family discovery and body installation live in the bounded
`ir-plain-implicit-constructors.ts` subsystem module instead of growing the
prepared-body driver.

The exact inventory fixture is:

```ts
function increment(value: number): number {
  return value + 1;
}
class Box {
  value(): number {
    return increment(41);
  }
}
export function run(): number {
  return new Box().value();
}
```

Before this slice, `increment` and `Box_value` were compile-once while `run`
reported `legacyBodyEmitted:true, irBodyEmitted:true`. After it, all three
terminals report `direct=0, IR=1` in GC and standalone, so the measurable
terminal improvement is **1 -> 0**. A `Box_new` direct-body poison and
`increment,run` direct-function poison stay green, proving neither support nor
terminal source bodies enter the old emitters. Both backends validate and
execute `run() === 42` with zero legacy outcomes.

Optimization and binary parity are exact for the inventory fixture. The
generated sizes and SHA-256 hashes match the pre-slice direct artifacts:

| Target | Bytes before/after | `Box_new` | `Box_init` | `Box_value` | `run` |
| --- | ---: | --- | --- | --- | --- |
| WasmGC | 661 / 661 | `09aa9869...26724` | `0054a90e...249f` | `12c24a74...f5b` | `72a05351...e023` |
| standalone | 21,122 / 21,122 | `cbf64de4...dc64` | `061c5143...208c` | `a9ef6662...977f` | `d6eef269...6c9c` |

The final bodies retain typed struct allocation, direct `_init` and method
calls, and the folded `f64.const 42`, with no ambient `this`, boxing,
`call_ref`, or `call_indirect`. Explicit GC/standalone negative controls prove
that implicit derived forwarding and instance field initialization still use
the direct class path and trip their direct-body poisons. Externref-backed and
nested/dynamic classes remain excluded by the same fail-closed boundary.
Because those consumers still exist, the shared implicit-derived and field-
initializer implementation is not deleted in this checkpoint.

The focused preparation, class, dependency, and Program ABI suites pass
**113/113**. Typecheck, formatting, oracle, ordinary and shape-diagnostic
fallback, issue/optimization-retirement, LOC, and function-budget gates are
green. The
IR-only shadow corpus is **37/37 IR-emitted, 0 legacy bodies, 0 Unsupported,
and 0 Invariants**. This branch remains local and stacked on queued PR #4395;
rebase, publication, and merge-queue entry wait until that immutable parent
lands.

### Implicit derived-forwarding checkpoint (2026-08-12)

This checkpoint extends the prepared implicit-constructor family through exact
local-user inheritance chains. A synthesized derived constructor now inherits
its parent's proven constructor parameter ABI, and preparation installs an
exact `_init(args..., self)` body that forwards those arguments and the same
receiver to the parent's `_init`, drops the parent result, and returns the
original receiver. Dependency discovery records the complete parent-init chain
recursively. Preparation is component-atomic: every implicit parent must be
staged in the same transaction, while an explicit parent constructor must be a
terminal owner in the prepared component. If either condition fails, the whole
constructing caller stays direct rather than mixing prepared and legacy bodies.

The Program ABI session records the forwarding contract before sealing and
accepts the non-terminal support body only when its signature, locals, ordered
argument loads, exact parent call, dropped parent result, and returned self all
match. Plain implicit constructors may now also contain declared-but-
uninitialized instance fields; their existing allocation wrapper supplies the
typed zero values before calling the exact empty `_init`. Initialized instance
fields remain a tested direct negative control because their ordered side
effects are not represented by this support-only slice.

The exact positive fixture is a three-level `Base -> Mid -> Leaf` chain where
`Base(number)` stores its argument and `run()` reads `new Leaf(7).value`. In GC
and standalone, `Base_new` and `run` are IR-only, all terminal outcomes contain
zero legacy bodies, and the implicit `Mid`/`Leaf` support pairs exactly match
the direct backend's canonical WAT. The terminal census improves **1 -> 0** for
the constructing caller. The prepared caller is strictly leaner than direct:
it calls `Leaf_new` and reads the field without the direct null-check/throw
scaffolding, ambient `this`, boxing, `call_ref`, or `call_indirect`.

The paired unoptimized artifacts are smaller while every implicit support body
remains shape-identical:

| Target | Direct | Prepared IR | Delta |
| --- | ---: | ---: | ---: |
| WasmGC | 1,428 bytes | 1,212 bytes | -216 bytes (-15.1%) |
| standalone | 46,767 bytes | 21,512 bytes | -25,255 bytes (-54.0%) |

An additional GC/standalone fixture proves a declared numeric field is
zero-initialized and reaches IR-only execution. A separate initialized-field
base plus implicit child proves atomic withdrawal, preserves `run() === 7`,
and trips the direct-body poison when the legacy constructor is disabled.

The full focused preparation, class, dependency, and Program ABI matrix passes
**121/121**. Typecheck, formatting, oracle, fallback, shape diagnostics, issue
integrity, optimization-retirement, LOC, and function-budget gates are green.
The IR-only shadow remains **37/37 IR-emitted, 0 legacy bodies, 0 Unsupported,
and 0 Invariants**. No shared legacy helper is deleted yet: initialized fields,
default/rest and forward ABIs, unsafe or conditional `super`, externref/builtin
construction, and nested/class-expression owners still consume those paths.
Each remaining family must delete its obsolete implementation in the same PR
that proves its complete IR replacement.

### Initialized instance-field checkpoint (2026-08-12)

This checkpoint moves fixed-name instance property initializers into the same
source-owned constructor `_init` IR as explicit constructor statements. One
immutable source-order plan records each public/private/literal-computed field
and expression. An implicit base constructor runs its own plan before return;
an implicit derived constructor calls the exact parent `_init` on the same
receiver and then runs its own plan; an explicit derived constructor runs its
plan immediately after the one selector-proven leading `super(...)`. Dynamic
computed field names refuse the complete constructor atomically instead of
partially initializing an object.

Initialized implicit constructors are now ordinary terminal class-member
owners, not a special direct-only exception. Their exact class declaration is
carried through identity validation, ambient/import call planning, combined
free/class dependency closure, Program ABI layout sealing, IR build/lower, and
the direct-body skip audit. The inventory's hard-coded
`implicit-class-initializer` failure was deleted. Explicit and implicit
constructors share `lowerConstructorFieldInitializers`; no legacy expression
compiler is called from the IR route.

The GC/standalone matrix proves a three-level `Base -> Mid -> Leaf` initialized
field chain returns `11323`, every `_new` terminal records `direct=0, IR=1`,
and each `_init` has exactly one typed `struct.set` after its exact parent call.
A second matrix proves base fields precede the explicit base body and child
fields run after `super` but before the explicit child body (`124645`). A third
matrix proves `inline-small` still removes both calls to a numeric helper from
field initializers. A fourth matrix proves private and literal-computed
instance fields use the same typed writes while a static initializer remains
outside the constructor plan. Direct class/function poison is active in all
four matrices, both Wasm targets validate, and no prepared terminal reports a
legacy body. A separate dynamic-computed-name fixture records a typed selector
`Unsupported`, emits exactly one legacy constructor body under hybrid policy,
and trips the direct-body poison; the prepared route therefore cannot claim a
partial initializer plan.

The paired unoptimized inheritance artifact is smaller on the prepared route:

| Target | Direct | Prepared IR | Delta |
| --- | ---: | ---: | ---: |
| WasmGC | 1,846 bytes | 1,682 bytes | -164 bytes (-8.9%) |
| standalone | 47,869 bytes | 21,868 bytes | -26,001 bytes (-54.3%) |

The base initializer's value-producing WAT is identical apart from IR's final
explicit `return`. Derived IR bodies are strictly shorter because the typed
receiver removes the direct nullable/nominal receiver guards before inherited
field reads; no `ref.test`, ambient `this`, boxing, `call_ref`, or
`call_indirect` remains. Optimization decision
`IR-OPT-TYPED-INSTANCE-FIELD-INITIALIZATION` is therefore retirement-ready.

The expanded adjacency matrix also exposed and closes a preparation-order
regression: when one caller in a provisional component had a hard foreign-unit
failure, the sealer treated a sibling's already-observed native string-concat
provider as non-retryable and withdrew `Animal_speak` / `Dog_speak` with the
caller. Mixed-failure peeling now removes only the hard owner, rederives the
component, and plans the remaining callable provider. Exact outcome assertions
prove those methods compile once with zero legacy bodies in host-string and
native-string lanes. The focused R2/R3 matrix passes **133/133**; hybrid and
strict single-host shadows both pass at **37/37 IR, 0 legacy bodies, 0
Unsupported, and 0 Invariants**. Typecheck, lint, formatting, ordinary and
shape-diagnostic fallback, issue/optimization-retirement, LOC/function budget,
oracle/adoption, equivalence, and the **29/29** cross-backend differential gate
are green.

The shared direct initializer loop is not yet dead: dynamic computed fields,
externref/builtin classes, nested/class-expression owners, and constructor
families withdrawn by default/rest/forward ABI or unsafe `super` policy still
consume it. Deleting that loop in this checkpoint would remove supported
fallback behavior. Those consumers remain the next exact family slices; the
loop is deleted with the last one, after a fresh reachability proof.

The resumable checkpoint is published as ready PR #4402 from
`codex/3522-general-classes-retirement` in
`/private/tmp/ts2wasm-3522-general-classes-retirement`. It was rebased and
fully requalified after parent PR #4395 landed. Once #4402 enters the merge
queue, do not modify its branch; resume the next exact constructor family only
after this overlapping production checkpoint lands.

### Merge-queue field-call closure repair (2026-08-12)

The first #4402 merge-group Test262 comparison found three genuine
pass-to-compile-error regressions in public instance-field abrupt-completion
coverage:

- `fielddefinition-initializer-abrupt-completion.js`;
- `init-err-evaluation.js`; and
- `super-fielddefinition-initializer-abrupt-completion.js`.

The identity call-edge inventory already attributed each `x = f()` call to
the exact explicit or implicit constructor terminal. The fault was later in
routing: the combined free/class fixed point correctly removed a constructor
when `f` was not IR-preparable, but the post-direct overlay retried that
rejected class member after emitting its legacy body. Its projected direct-call
targets intentionally excluded `f`, so the retry became an invariant instead
of the typed atomic withdrawal the fixed point had decided.

The routing boundary now removes only those considered class-member UnitIds
that did not survive the prepared owner closure, records
`late-preparation-unsupported`, and leaves their legacy bodies untouched. It
does not weaken the positive initialized-field path: the existing inline-small
matrix still prepares `bump`, the constructor, and its caller together. A new
GC/standalone negative matrix executes the abrupt completion, proves the
constructor and callee remain direct, activates the class-body poison seam,
and requires the hybrid binary and WAT to be byte-for-byte identical to the
direct compilation. A maintained path-filtered Test262 run restores all three
merge-group regressions to pass (and the matching class-expression variant),
with zero compile errors. The two wider substring matches remain their known
baseline runtime failures rather than changing category. The ready PR remains
held outside the queue until the complete branch gates are requalified.

### Merge-queue shard-completion repair (2026-08-12)

The next #4402 merge-group run contained no standalone verdict changes in the
rows it completed, but standalone shards 10 and 17 terminated their single
Vitest file process at its 512 MiB heap limit. They uploaded only 305 and 188
rows respectively instead of their complete roughly 1,350-row partitions.
Vitest uses exit code 1 both for ordinary Test262 assertion failures and for
this parent-process failure, and the shard workflow intentionally accepted 1;
the partial JSONLs therefore reached the merge job and appeared as a false
standalone high-water regression. Every one of the 493 completed rows has the
same status as the exact main baseline. The four compiler workers did not OOM
and retain their independent 512 MiB limits.

The Test262 file process now receives the same 1 GiB heap ceiling already used
by the repository's issue and equivalence gates. Both the ordinary sharded
baseline path and the consolidated merge-group path use that ceiling, and the
independent refresh-baseline workflow mirrors it. This is runner capacity, not
a compiler-policy or oracle change.

More importantly, shard completion is now fail-closed. `test262-shared.ts`
writes a source-specific completion marker only from `afterAll`, after all
registered tests settle and the JSONL descriptor closes. Every shard-producing
workflow requires that marker before accepting Vitest's otherwise-ambiguous
exit code 1, and publishes it beside the JSONL for audit. An OOM, signal, or
other early parent death can no longer masquerade as complete conformance
evidence even if it leaves a non-empty partial file.

The one JS-host pass-to-fail row from the same merge group was replayed first as
an exact single path and then inside its complete 66-way shard with the pinned
Test262 revision and pool size four; both replays passed. It is therefore kept
classified as a queue flake rather than patched into production semantics.
Re-enqueue still requires the parent-heap/completion-marker workflow contracts,
the exact affected standalone shard replay, and the complete branch gates to
pass.

Local qualification with the pinned `b363f29d` Test262 tree, pool size four,
the exact full runtime-eval provider, and the new parent ceiling completed both
formerly truncated 36-way partitions: shard 10 and shard 17 each recorded and
marked **1,357/1,357** rows. Shard 10 is status-identical to the current main
baseline across all 1,357 rows. Shard 17 has three local RegExp Unicode-property
failures whose baseline rows are passes, but an isolated worktree at the exact
`4227031433a964` baseline commit reproduces the same three failures with identical
error signatures on this host; they are platform-control differences, not
#4402 changes. The merge queue remains the authoritative Linux comparison.

### Forward/exact class-reference ABI checkpoint (2026-08-12)

The next R3 family moves exact class references out of body-time ABI repair.
TypeScript permits a constructor, method, or accessor in an earlier class to
refer to a class declared later in the same source. Class callable slots were
historically reserved before that later struct existed and therefore received
provisional `externref` positions. The direct class-body compiler repaired the
signature while emitting the body. A Prepared owner correctly skips that
compiler, which exposed the phase violation as both missing symbolic class
bindings and a final callable-signature mismatch.

`orderIrClassShapeDeclarationsForProjection` now performs a stable,
identity-based topological projection for acyclic local class-position
dependencies. It preserves the authoritative published class order and does
not widen the heritage policy. After all class structs are registered, the
dedicated backend-neutral `class-callable-abi.ts` phase finalizes fixed
constructor, method, getter, setter, and static-method slots before IR planning
or either body emitter can run. The direct compiler's late re-resolution stays
temporarily as an idempotent hybrid assertion and remains live for families not
covered here.

The exact `Holder -> Value` fixture establishes the measured boundary. On
current main, all five `Holder` terminals (`_new`, instance method, getter,
setter, and static method) report `legacyBodyEmitted:true` and IR false in both
targets; the combined constructing caller then fails the final provisional ABI
invariant. This checkpoint makes all five compile once through IR (**5 -> 0
legacy bodies**) and the complete seven-terminal fixture validates and returns
`5` in WasmGC and standalone. Direct-class-body poison covers every migrated
member, so an emitted legacy body cannot satisfy the positive test.

Optimization and representation parity are explicit. Every migrated callable
uses the exact `(ref null $Value)` ABI and the WAT rejects `externref`,
`any.convert_extern`, `extern.convert_any`, `ref.test`, `ref.cast`, `call_ref`,
and `call_indirect`. The exact class-typed field fixture likewise accepts a
field only when its already-committed struct index matches the projected class
identity. Prepared artifacts are smaller than the same-source direct artifacts:

| Fixture | Target | Direct | Prepared IR | Delta |
| --- | --- | ---: | ---: | ---: |
| forward callable positions | WasmGC | 1,720 bytes | 1,261 bytes | -459 bytes (-26.7%) |
| forward callable positions | standalone | 47,614 bytes | 21,490 bytes | -26,124 bytes (-54.9%) |
| exact class-typed field | WasmGC | 1,562 bytes | 1,224 bytes | -338 bytes (-21.6%) |
| exact class-typed field | standalone | 46,973 bytes | 21,466 bytes | -25,507 bytes (-54.3%) |

Two fail-closed controls define what this PR does not claim. A field that
refers to a later class remains direct because the legacy class collector has
already committed that storage slot as `externref`; fixing callable order must
not silently rewrite object layout. A mutually recursive `Left <-> Right`
constructor ABI also remains direct because immutable recursive class-shape
cells do not exist yet. Default/rest/optional parameters, unsafe `super`,
externref/builtin classes, and nested/class-expression owners retain their
existing typed route.

No shared legacy implementation is deleted in this checkpoint. Forward fields,
recursive layouts, the direct-only mode, and the other excluded class families
still consume the late class ABI/body paths. The next exact R3 transaction is
forward class-field layout commitment; recursive cells follow separately.

Qualification after rebasing onto current `origin/main` is green. The complete
focused R2/R3 matrix passes **122/122**. Hybrid and fail-closed IR-only shadows
both report **37/37 IR, 0 legacy bodies, 0 Unsupported, and 0 Invariants**. The
ordinary fallback gate has zero unintended, post-claim, or module-level
rejections; the shape diagnostic has zero attributed body-shape rejections.
All eight equivalence shards report **1,645 passing, 24 known failures, and zero
new regressions** (twelve stale baseline entries now pass but are deliberately
not mixed into this PR). Cross-backend differential is **29/29**. Typecheck,
lint, formatting, issue/optimization-retirement integrity, oracle separation,
IR adoption, verdict-oracle, LOC, and function-budget gates also pass.

### Forward class-field layout checkpoint (2026-08-13)

Exact forward class references now cross the physical storage boundary before
any source body emits. Class collection still reserves structs in source order,
so `Holder.current: Value` is initially an `externref` slot when `Value` is
declared later. The new post-collection `class-field-layout.ts` phase resolves
the exact declaration through the Type Oracle and mutates that already-observed
field in place to `(ref null $Value)` before callable finalization and class
shape planning. It does not pre-reserve or reorder types, and it does not
replace the `StructTypeDef` object held by the Program ABI type cell.

This checkpoint is deliberately bounded to explicit identifier/private fields
on unique, flat, top-level classes in one source. The reference must be a bare,
non-generic `TypeReferenceNode` to a later unique local class, and the complete
field dependency graph must be acyclic. Classes participating in inheritance,
recursive/self layouts, nested/class-expression owners, optional/union/generic
annotations, constructor-only inferred fields, and externref-backed targets
remain on the typed direct route. Multi-source finalization remains R5 work.

The primary `Holder -> Value` fixture now gives all four source bodies
(`Holder_new`, `Holder_replace`, `Value_new`, and `run`) one prepared IR owner in
WasmGC and standalone under both direct-class and direct-function poison. It
validates and returns `25`, and the committed field plus constructor assignment,
method read/write, and constructing caller contain no `externref` conversion,
cast/test, or indirect-call traffic. Separate parity controls prove:

- an initialized `current: Value = new Value(2)` retains the established typed
  instance-field initialization optimization and per-instance behavior;
- multiple public/private fields retain their exact shared target layout;
- an adjacent default-parameter method can remain a typed direct fallback while
  consuming the same finalized physical field ABI; and
- mutual field recursion and any inheritance participant remain direct, with
  the unresolved forward slot still physically `externref`.

The exact A/B driver runs the same allocation, field replacement, and two field
reads per iteration. Three repeated local measurements produced identical
artifact sizes and correct checksums:

| Target | Direct binary | Prepared IR binary | Delta | Direct median | Prepared median |
| --- | ---: | ---: | ---: | ---: | ---: |
| WasmGC | 2,836 bytes | 1,292 bytes | -1,544 bytes (-54.4%) | 3.318-3.684 us | 0.010-0.011 us |
| standalone | 47,714 bytes | 21,531 bytes | -26,183 bytes (-54.9%) | 0.011-0.012 us | 0.010-0.011 us |

The WasmGC direct lane's host-carrier path explains its much larger runtime
gap; the relevant retirement requirement is satisfied in both targets: prepared
IR is no larger and no slower than direct. A forward field forms a valid WasmGC
recursive group spanning the owner-to-target type interval; binary validation,
exact WAT assertions, and the artifact reduction guard that representation
effect. The direct-only lane is unchanged and remains the A/B control.

No shared legacy implementation is deleted here. The same direct layout/body
code still has live consumers in every excluded family, and deleting it would
violate the retirement rule. The next serial R3 transaction is immutable
recursive class-layout cells for self and mutually recursive class fields;
after that, extend the same proof to inheritance participants before nested and
multi-source owners.

### Recursive class-layout cell checkpoint (2026-08-13)

Self and mutually recursive flat class graphs now cross the same prepare-before-
emit boundary. `buildIrClassShapes` allocates compiler-branded, identity-stable
descriptor cells for every eligible exact class before projecting constructor,
field, and method positions. It fills those cells once, removes any incomplete
cell plus every transitive consumer before publication, and preserves source
order in the public sidecar. Selection can therefore resolve `Node.next: Node`
and `Left.right: Right -> Right.left: Left` without a name fallback or a late
body-time ABI repair.

The physical layout finalizer now admits the same exact recursive field edges.
It mutates only the pre-existing field object after every struct is registered,
so WasmGC forms the required recursive type group without replacing a Program
ABI type cell or changing type order. Inheritance participants, nested/class-
expression owners, optional/union/generic annotations, inferred constructor
fields, externref-backed targets, and multi-source graphs remain excluded.

Prepared ownership remains fail-closed. Recursive shape cells carry a private
compiler symbol; the immutable prepared-data copier may preserve a back-edge
only through a structurally valid branded class shape. Arbitrary object, map,
set, and class-lookalike cycles still raise `invalid-prepared-data`. Backend
legality and linear-memory layout discovery now track visited exact shape
objects, so a valid class cycle terminates while visiting every nominal class
once. A unit test proves the linear planner interns two distinct layouts for a
mutual cycle; linear legality continues to reject the unsupported `class` atom
with finite, stable diagnostics rather than recursing.

The executable GC/standalone matrix covers both a mutual cycle and a self
cycle. The mutual fixture prepares **six** terminal source bodies (`Left_new`,
`Left_attach`, `Left_value`, `Right_new`, `Right_attach`, and `run`) with
`direct=0, IR=1`; the self fixture prepares **four** (`Node_new`, `Node_link`,
`Node_sum`, and `run`) with the same counters. Direct class/function poison is
active, both binaries validate, and runtime returns `14` and `7`. Exact WAT
assertions require nullable nominal field refs plus typed `struct.get`/
`struct.set` and direct calls; the migrated bodies reject extern conversions,
casts/tests, and indirect calls. The mutual-cycle IR artifact is no larger than
the same-source direct artifact in either target.

The focused R2/R3 completion matrix is green at **126/126**. The complete class
file is **42/42**, exact shape/program ownership suites are **29/29**, and the
hybrid plus strict shadows remain **37/37 IR, 0 legacy bodies, 0 Unsupported,
and 0 Invariants**. Ordinary and shape-diagnostic fallback gates report zero
unintended/post-claim/module-level increases and zero attributed body-shape
rejections. Typecheck, changed-file lint, and formatting pass. Wider
equivalence, cross-backend, optimization-retirement, integrity, adoption,
oracle, and budget gates remain required before publication.

No shared direct implementation is deleted in this checkpoint. Inheritance
participants and the other excluded class families still consume it. The next
serial R3 transaction extends exact field-layout finalization through local
inheritance without allowing recursive heritage, then tackles nested/class-
expression ownership. The obsolete direct implementation is removed in the
same later transaction that proves its last consumer is gone.

### Inherited class-layout checkpoint (2026-08-13)

Exact forward class fields now remain typed through local user inheritance.
The physical class collector deliberately shares each parent's `FieldDef`
objects with its descendants, so the post-collection finalizer updates a
parent-owned forward slot once and every already-collected subtype observes
the same `(ref null $Target)` storage. A forward field declared by the child is
finalized independently. No struct is replaced, no type is reordered, and
externref-backed, nested, generic, optional, union, or inferred layouts remain
outside this transaction.

Derived classes now receive the same identity-stable provisional class-shape
cells as flat classes. Projection adds the exact heritage parent as a
dependency, guaranteeing that implicit constructor forwarding reads a fully
populated parent ABI while recursive field edges still use stable cells. The
existing earlier-parent rule rejects later, foreign, builtin, and unresolved
heritage, so this does not admit recursive inheritance or widen the supported
extends surface.

The GC/standalone proof uses an exact three-level hierarchy. `Base.current`
references later `Value`, `Child.other` references the same target, and
`Value` itself extends an earlier `Amount`. All six class terminals plus the
top-level caller record `legacyBodyEmitted:false, irBodyEmitted:true` while
both direct-body poison seams are active. Direct and IR binaries validate and
return `13`; the IR artifact is no larger than direct. WAT requires exact typed
storage in both `Base` and the inherited prefix of `Child`, rejects externref
and indirect dispatch in migrated bodies, and pins the derived initializer to
one static parent narrowing plus one direct parent call before its typed
`struct.set`.

The complete class compile-once file passes **42/42** after the change. This
checkpoint does not delete a shared direct implementation: nested/class-
expression owners and the remaining typed fallback policies still consume the
class collector/body machinery. After publication, the next serial R3 family
is exact nested/class-expression ownership; shared code is removed only with
the last proven consumer.

### Bounded nested ordinary-class ownership checkpoint (2026-08-13)

Named ordinary classes declared inside a function can now join the same
prepare-before-emit transaction as their containing caller. The admitted
family is deliberately effect-free at class-definition time: no heritage,
decorators, static elements, computed keys, field initializers, async/generator
methods, optional/rest/default parameters, or body captures. It has one fixed
constructor and at least one fixed-name instance method. Those restrictions
let the IR body treat the declaration as a lexical class binding while Program
ABI owns every executable member before the containing body lowers.

Identity inventory promotes the nested constructor and methods to exact
terminal units with their containing function as owner. Selection is atomic:
the caller, constructor, and every method must all claim with one projected
class layout and exact callable graph, or the complete component stays direct.
Prepared dependency sealing may borrow that nested layout only for exact
members of the same containing owner. Declaration/body routing then visits the
fully prepared class solely to correlate its skipped slots; neither the
enclosing direct function compiler nor nested class-body compiler may emit the
source bodies.

The GC/standalone proof uses `run -> Calculator { constructor, add, scale }`.
All four terminals share one prepared component and report
`legacyBodyEmitted:false, irBodyEmitted:true` while both direct function and
direct class-body poison seams are active. Both targets validate and return
`715`; the prepared artifact is no larger than the same-source direct artifact.
The constructor uses typed `struct.set`, both methods use typed `struct.get`,
and migrated bodies reject extern conversions, casts/tests, `call_ref`, and
`call_indirect`. A captured outer `offset` is the fail-closed control: the
caller and every class member remain one Unsupported/direct component and
return `42`, so a mixed caller/member policy cannot satisfy the test.

The implementation preserves the separate nested-accessor policy. A focused
audit initially exposed that projecting every nested class changed a TDZ/
writeback accessor control from typed fallback into a late ABI failure. The
candidate resolver and structural class-name set now widen only for this
bounded ordinary family; all **21/21** accessor writeback tests pass, including
the injected sibling-TDZ rejection, and the existing top-level default-
parameter class retains its exact `class-projection-unsupported` outcome.

Qualification after the inherited-layout checkpoint landed is green:

- focused R2/R3 ownership matrix: **129/129**;
- nested ordinary ownership plus accessor audit: **24/24**;
- cross-backend differential: **29/29**;
- equivalence: **1,645 passing, 24 known failures, zero new regressions**;
- hybrid and strict shadows: **37/37 IR bodies, 0 legacy bodies, 0
  Unsupported, 0 Invariants**;
- ordinary fallback gate: zero unintended, post-claim, or module-level
  increases; shape diagnostic: zero attributed body-shape rejections; and
- typecheck, lint, and formatting pass.

No shared direct implementation is deleted in this checkpoint. Class
expressions and nested classes with inheritance, static/effectful elements,
computed keys, initializers, flexible parameters, or captures still consume
the nested class/body machinery. The remaining serial R3 checklist is:

1. closures, object methods/accessors, and cross-owner callable support;
2. module initialization under #3523;
3. runtime and linear-memory helpers; and
4. delete each direct implementation when its final typed consumer reaches
   zero, then enable IR-only as the default.

### Const-bound nested class-expression ownership checkpoint (2026-08-13)

The next nested-class family is now a prepare-before-emit transaction for the
exact effect-free `const C = class { ... }` and `const C = class C { ... }`
forms. The class expression keeps its synthetic legacy callable/layout label,
while the exact const binding is published as a selector/lowerer alias. The
identity selector, checker-backed class resolver, Program ABI constructor
support transaction, and declaration skip audit all correlate through the
same `IrClassId`; the surrounding function, `_init`, AST-free `_new`, and every
method either prepare as one component or remain direct together.

The bounded family does not turn a class object into an IR runtime value.
Selection proves every reference to the const binding is the callee of direct
`new C(...)`. Passing, comparing, returning, or otherwise reading `C` keeps the
whole component direct. Mutable bindings, differently named inner class
expressions, captures, inheritance, decorators, static/effectful elements,
computed keys, field initializers, flexible parameters, and unsupported member
bodies also remain fail-closed.

Explicit parity evidence covers both GC and standalone:

- the enclosing `run`, constructor, `add`, and `scale` terminals share one
  prepared component with `legacyBodyEmitted:false` and
  `irBodyEmitted:true` while both direct-body poison seams are active;
- both targets validate and return `715`, with typed `struct.set`/`struct.get`
  bodies and no extern conversions, casts/tests, `call_ref`, or
  `call_indirect` in migrated functions;
- prepared binary size is **1,232 vs 1,557 bytes** direct on GC and **21,536
  vs 47,058 bytes** direct on standalone; and
- first-class-value, mutable-binding, and differently-named controls preserve
  direct runtime semantics and record no post-claim failures.

Focused class/expression/accessor qualification is **71/71**, including all
42 class compile-once tests and all 21 nested-accessor writeback tests. The
broader R2/R3 ownership matrix is **134/134**, cross-backend differential is
**29/29**, and equivalence is **1,645 passing, 24 known failures, zero new
regressions** (12 baseline failures now pass). Hybrid and strict shadows remain
READY at **37/37 IR bodies, 0 legacy bodies, 0 Unsupported, 0 Invariants**.
The fallback gate has zero unintended, post-claim, or module-level increases;
typecheck, lint, formatting, optimization retirement, LOC, and function-budget
gates pass.

No shared direct class-expression implementation is deleted yet. First-class,
module-level, inline, capturing, and effectful class-expression consumers still
use it. The next serial R3 owner is closures/object methods/cross-owner callable
support; after those consumers reach zero, the obsolete direct branches must be
deleted in the same checkpoint that proves their last use is gone.

### Lifted nested-function ownership checkpoint (2026-08-13)

Ordinary nested function declarations can now enter the enclosing terminal's
prepare-before-emit transaction. The enclosing function and each admitted
nested declaration lower together before the direct function-body compiler
runs. If any nested body or prepared dependency fails, the transaction remains
typed Unsupported and the existing direct route owns it once.

The important accounting fix is structural: a lifted nested declaration now
keeps its exact inventoried `nested-function` `IrUnitId`. It is no longer
reported as a pass-created derived unit that happens to share the parent's
display-name namespace. Lowering records its exact lexical parent, terminal
owner, and source ordinal; integration verifies those fields against the
frozen inventory. Only genuinely compiler-created lifts (including the narrow
Promise-delay closure support) register `ProgramAbiDerivedUnitRecord`s.

The bounded proof uses `run -> add`, with one captured scalar and one direct
call. With direct `run` emission poisoned, GC and standalone both prepare the
owner, allocate the nested source callable through the scoped Program ABI,
validate, and return `42`. Optimized IR artifacts are no larger than their
same-source direct artifacts. An independent AST-to-IR assertion proves the
lifted function's ID is exactly the inventory ID rather than a newly derived
ID.

Focused nested/closure ABI evidence is **40/40** across this proof, the exact
Promise-delay closure compile-once suite, prepared-scope sealing, and exact
artifact/report identity. The broader closure/recursion matrix is **47/47**;
the structural identity/Program ABI matrix is **51/51**; cross-backend parity
is **29/29**; equivalence is **1,645 passing, 24 known failures, zero new
regressions**; strict shadow remains **37/37 IR, zero legacy/Unsupported/
Invariant**; and fallback, typecheck, lint, formatting, issue integrity, and
optimization-retirement gates pass.

Generic arrow/function-expression closure literals remain on the transitional
late-overlay route in this checkpoint. The first combined probe was
semantically correct but exposed a GC closure-support size regression, so their
source-unit identities and support optimizations must land as their own
measured slice. Object methods/accessors and cross-owner callable values remain
after that.

No shared direct nested-function implementation is deleted yet. Unsupported
nested forms and the unretired closure-literal/object-method families still use
the same direct compiler. Delete it only when the final typed consumer reaches
zero.

### Arrow/function-expression closure-literal checkpoint (2026-08-13)

Ordinary arrow functions and function expressions now join their enclosing
terminal's prepare-before-emit component instead of forcing the owner through
the transitional direct-body overlay. Each literal keeps its exact inventoried
`arrow-function` or `function-expression` source ID, including checker/usage
transforms that clone a nested node. The source span, kind, source owner, and
terminal owner must all match; genuinely synthesized lifts still use derived
Program ABI provenance. Exact Promise-delay and one-shot host callbacks also
retain their preplanned derived target IDs: those are compiler-owned artifacts
whose plans are frozen before AST lowering, even though an arrow supplies their
syntax.

Mutable primitive captures now participate in the same sealed contract. Their
canonical physical ref-cell struct is planned by semantic inner IR type, owns
an explicit remappable Program ABI type ref, and is attached by object identity
to the final boxed type plus every `refcell.new/get/set`. Missing, empty, stale,
or unrelated evidence remains a typed preparation failure. Sibling closures
share one cell and observe each other's writes. Closure carrier structs remain
outside the user-data struct registry, preserving the direct backend's absence
of `__sget_cap*`, `__struct_field_names`, and GC `__is_data_struct` reflection
helpers.

The anti-vacuity proof covers one immutable captured arrow plus a no-capture
function expression, two sibling literals that share a mutable f64 capture,
and an outer arrow that owns another captured arrow. With direct owner emission
poisoned, GC and standalone prepare each complete tree atomically, validate,
and return the same values as direct codegen. Every nested literal has its exact
source ID. Optimized IR binaries are no larger than their same-source direct
binaries. The exact Promise-delay regression suite proves its executor and
timer callbacks keep their derived plan identities and execute in both
optimized and unoptimized builds.

Program ABI planner and dependency fail-closed coverage is **35/35**; focused
closure ownership is **12/12**; exact Promise planning and execution is
**8/8**; the adjacent direct closure/function-expression matrix is **56/56**
after its legacy bare-import helpers were updated to link the compiler-declared
runtime imports; typecheck, formatting, and the fallback ratchet pass with no
unintended/post-claim/module-level increase. Hybrid and strict shadows remain
**37/37 IR bodies, 0 legacy bodies, 0 Unsupported, and 0 Invariants**.

Recursive named/self-bound literals, default/destructured parameter forms,
returned closure values, and other cross-owner callable escapes remain on the
typed direct route. Object-literal methods/accessors are the next serial R3
family. No shared direct closure implementation is deleted yet; retire each
branch with the final consumer and keep its optimization/parity assertions in
that deletion checkpoint.

### Top-level function-value target checkpoint (2026-08-13)

A top-level function declaration no longer has to retain its direct body merely
because another owner materializes it as a runtime value. The selector admits
the target when its body and callable signature are otherwise R2-safe, while
the value-using owner remains direct unless it already has an exact IR
function-value plan. Before any target component seals, codegen allocates the
canonical lazy singleton and freezes its exact source-owned
`function-value-trampoline` plus mutable `function-value-cache` Program ABI
bindings. A later direct read must reuse those allocator objects; it cannot add
support to an already sealed component.

The checkpoint proves local-variable and module-object escapes with the target
direct-body emitter poisoned: the target reports `direct=0, IR=1`, validates,
and returns the expected value. GC and standalone parity cases prove repeated
reads retain JavaScript singleton identity and that optimized IR binaries are
no larger than their same-source direct binaries. Structural coverage resolves
both support bindings to final function/global slots beneath the target's exact
terminal unit, preventing a generic name-owned trampoline from satisfying the
runtime-only tests.

Only the target crosses this one-way boundary. General value-consuming owners,
returned/escaped closure values, capture-carrying cross-owner calls, object
methods/accessors, and callable values that require dynamic dispatch remain on
the typed direct route. No shared direct closure implementation is deleted in
this checkpoint because those consumers still reach it.

The exact current-function `caller` / `arguments` poison-pill read also remains
direct until IR owns the equivalent activation/caller hand-off. The merge-queue
Test262 probe `built-ins/Function/15.3.5.4_2-12gs.js` caught this boundary: an
otherwise safe sloppy function is materialized as a value by strict `eval`, but
its legacy `caller` observation still depends on direct activation state. That
handoff is source-wide, so runtime-materialized function targets in the same
source also stay direct; otherwise an unrelated Prepared target can still alter
the final direct-call instrumentation. The checkpoint carries a focused runtime
parity test for that boundary. Ordinary function-value targets in sources that
do not observe the legacy activation continue to prepare.

### Returned closure component checkpoint (2026-08-13)

A top-level function may now return an exactly annotated primitive callable
and seal together with a caller that stores and invokes that returned value.
The source result uses the same canonical callable/externref ABI already used
for callable parameters. Inside the producer, a literal remains the optimized
typed closure carrier until the return seam packs it once; the caller unpacks
the exact signature for indirect dispatch. This preserves the existing
closure representation and avoids a dynamic-value round trip.

Preparation now recognizes callable source results as backend-stable. This is
required for correctness, not just coverage: the inventoried returned arrow
must receive its source-owned callable slot inside the prepare-before-emit
transaction. Leaving the producer on the late route exposed an empty legacy
placeholder with `typeIdx = 0` during Program ABI sealing. The producer and
caller are closed over the same exact call edge, so neither side can retain a
legacy body or cross an unplanned ABI.

The anti-vacuity fixture is `make(offset) -> (value) => value + offset`, then
`run` stores `make(2)` and invokes it. With both direct body emitters poisoned,
GC and standalone emit `make`, its captured lifted arrow, and `run` through IR,
record `direct=0, IR=1` for both terminal functions, share one prepared
component ID, validate, and return `42`. Same-source optimized direct builds
provide the performance/size oracle; the IR binaries are no larger. A shadowed
local `make` negative control proves the call-graph exemption does not fall
through to a same-text top-level factory.

Focused returned/ordinary/lifted closure plus prepared-free-function coverage
is **45/45**, with typecheck green and zero post-claim errors. The next serial
R3 families are recursive named/self-bound literals, default/destructured
closure parameters, object-literal methods/accessors, and wider cross-owner
callable escapes. No shared direct closure implementation is deleted yet;
those remaining typed consumers still require it.

The later accumulated closure stack exposed one missed form in the original
call-graph proof: `var fn = make(10); fn(32)` passed the ordinary statement
selector but the graph collector recorded returned callables only for `const`.
That mislabeled the caller as external, split it from `make`, and left the
lifted arrow on a late placeholder with `typeIdx = 0`. The collector now keeps
the existing const-only rule for literal closure declarations but recognizes
an exact direct returned-callable binding under `var`/`let` as well. The
equivalence regression is now an explicit GC/standalone poison-and-size parity
test: producer, caller, and lifted arrow share one prepared component, both
terminal bodies are IR-only, runtime returns 42, and optimized IR stays no
larger than direct.

### Recursive named function-expression checkpoint (2026-08-13)

A named function expression now binds its lexical self name directly to the
canonical typed closure carrier inside its lifted IR body. Recursive calls
therefore reuse the existing `closure.call`/`call_ref` path and pass the exact
root carrier as `this` without introducing a dynamic lookup, global alias, or
second closure allocation. Capture analysis excludes the self name while
retaining ordinary outer captures in their existing sealed order.

The selector mirrors that ownership boundary: the self name exists only in the
literal's inner scope, carries the literal's exact callable projection while
the body is checked, and disappears when the projection scope closes. A same-
named enclosing binding remains deliberately unsupported for this slice rather
than allowing ambiguous shadow evidence to widen selection.

Anti-vacuity coverage runs both a zero-capture factorial and a recursive
factorial with independent captured state on GC and standalone. With the
terminal direct-body emitter poisoned, every prepared build reports
`direct=0, IR=1`, validates, contains the lifted closure plus `call_ref`, and
matches the direct runtime result. Optimized IR binaries are no larger than
their same-source direct binaries. Default/destructured closure parameters,
object-literal methods/accessors, and wider cross-owner callable escapes remain
the next serial R3 families; the shared direct closure implementation still has
live typed consumers and is not deleted in this checkpoint.

### Flat destructured closure-parameter checkpoint (2026-08-13)

Closure literals may now receive flat object and numeric-array binding patterns
through the same prepared component as their terminal owner. The lifted body
keeps one synthetic parameter carrying the complete aggregate, then reuses the
ordinary IR binding-pattern lowering to project each leaf. Capture analysis
records every pattern leaf as locally owned, so renamed fields and elisions do
not become phantom outer captures.

The admitted object ABI is intentionally checker-independent and bounded to a
non-empty inline type literal with unique required primitive fields. Numeric
arrays use the existing nullable vector carrier. Named object types, nested or
defaulted patterns, optional/rest parameters, and non-numeric arrays remain on
the direct route until closure signatures receive their planned position-type
sidecar or the corresponding JavaScript calling convention is prepared.

Closed object layouts used by prepared closure signatures are now allocated
before sealing and registered under exact, remappable Program ABI type refs.
Dependency discovery accepts `object.new/get/set` only when the final object
type identity carries that evidence. A missing ref and a structurally equal but
distinct type both remain blocked; the physical allocator object may be
remapped without losing the symbolic binding. The broader sealing diagnostic
also reports exact dependency failures for ordinary owners instead of hiding
them behind a generic late artifact error.

Anti-vacuity coverage runs renamed/captured object destructuring and numeric
array destructuring with an elision in both GC and standalone. Direct-body
poison proves `run` and its lifted closure are IR-owned, runtime results match
same-source direct builds, emitted WAT contains the expected `struct.get` or
`array.get` plus `call_ref`, and each optimized IR binary is no larger than its
direct oracle. Focused closure-support and dependency coverage is **41/41**.
Defaulted closure parameters, object-literal methods/accessors, and wider
cross-owner callable escapes remain the next serial R3 families. The shared
direct closure implementation still has those live typed consumers, so it is
not deleted in this checkpoint.

### Numeric defaulted closure-parameter checkpoint (2026-08-13)

A const-bound arrow/function-expression closure may now carry a contiguous
suffix of explicitly annotated `number` parameters with constant numeric
defaults. Its logical IR signature records the first defaulted position while
retaining the complete physical parameter list. Local calls therefore accept
every JavaScript arity from that first default through the declared parameter
count, pad omitted positions with the exact legacy expression-default sNaN
sentinel, and treat an unshadowed explicit `undefined` identically. The lifted
IR body recognizes the sentinel by exact `i64.reinterpret_f64`/`i64.eq` bits
and selects the declared constant before any parameter use.

The closure header's `$arity` is the first defaulted position, preserving
Function `length` metadata without creating a second closure layout or lifted
function type. String/vec carrier rewrites preserve the logical default
metadata, while physical Program ABI and wrapper layout reuse remain keyed by
the full Wasm parameter/result signature. Bytecode and Porffor continue to
reject the new i64 bit operations through their existing capability gates;
WasmGC and linear lower them through the shared typed emitter seam.

Anti-vacuity coverage exercises an all-default suffix through omitted,
explicit-`undefined`, partially supplied, and fully defaulted calls in both GC
and standalone. Direct-body poison proves `run` and its lifted closure are
IR-owned, runtime results match same-source direct builds, WAT pins the exact
bit test plus `call_ref`, and each optimized IR binary is no larger than its
direct oracle. The focused/default plus adjacent closure-family matrix is
**26/26**; fallback policy is unchanged and the strict IR-only shadow remains
**37/37 emitted, 0 legacy, 0 Unsupported, 0 Invariant**.

Effectful or cross-parameter defaults, optional/rest parameters,
object-literal methods/accessors, and wider cross-owner callable escapes remain
the next serial R3 families. The shared direct closure implementation still
has those live typed consumers, so it is not deleted in this checkpoint.

### Pure cross-parameter default checkpoint (2026-08-13)

Numeric default suffixes may now derive a default from earlier numeric
parameters through a bounded pure expression tree: literals, earlier parameter
reads, unary `+`/`-`, and binary `+`, `-`, `*`, or `/`. Default resolution stays
in declaration order, so a later default observes the already-resolved value
of an earlier default. The selector and AST-to-IR builder independently check
the same subset; self/later references, captures, calls, property reads, and
all other potentially effectful expressions remain direct.

GC and standalone parity coverage exercises omitted, partially supplied,
explicit-`undefined`, and fully supplied calls for `(value = 2, bonus = value +
3)`. Direct-body poison plus the compiled-function census proves both the owner
and lifted closure are IR-emitted; runtime values match same-source direct
builds, both binaries validate, and each optimized IR binary is no larger than
its direct oracle. The focused default suite is **5/5** and the adjacent
closure/prepared matrix is **60/60**. The fallback ratchet has no increase; the
strict IR-only shadow remains **37/37 IR, 0 legacy bodies, 0 Unsupported, and 0
Invariants**. Effectful/captured defaults, optional/rest parameters,
object-literal methods/accessors, and wider cross-owner callable escapes remain
direct.

### Captured numeric default checkpoint (2026-08-13)

A pure numeric default expression may now read a checker-proven numeric outer
binding. The AST-to-IR builder independently requires that binding to have an
`f64` local or boxed-`f64` carrier, and capture discovery includes parameter
initializers as well as the closure body. A mutable outer therefore uses the
same ref cell as sibling closures, so its default is read at call time after
earlier writes rather than frozen when the closure is allocated. An identifier
matching any current parameter but not an earlier initialized parameter is
rejected before build, even when a numeric outer binding has the same name;
this preserves JavaScript's parameter-scope TDZ rather than capturing the
outer value.

The GC/standalone proof mutates the captured value through one prepared sibling
closure, then calls the defaulted closure with an omitted and an explicit
argument. Both prepared bodies and both lifted closures survive direct-body
poison, validate, match same-source direct results, and keep optimized IR binary
size no larger than direct. A self-shadowing control proves the selector fails
closed with no post-claim error. The focused default suite is **8/8** and the
adjacent closure/prepared matrix is **63/63**. Calls, property reads, and other
effectful defaults remain direct; optional/rest parameters, object-literal
methods/accessors, and wider cross-owner callable escapes remain the next R3
families.

### Numeric object-method ownership checkpoint (2026-08-13)

Selector-certified `valueOf`/`toString` method shorthand with zero parameters,
an explicit numeric or boolean result, and no receiver-sensitive syntax now
lowers as an inventoried `object-method` source unit inside its terminal
owner's prepared transaction. The enclosing function builds a closed object
whose fields retain their exact closure signatures, then unary ToNumber reads
and invokes the preferred `valueOf`/`toString` closure directly. This preserves
the direct backend's static method-dispatch optimization instead of routing the
IR result through the generic open-object runtime.

Prepared closure support now plans closure-valued object fields against the
canonical closure root before scope sealing. The two late anonymous-shape
identity passes report their exact affected type indices back to Program ABI:
`$shape` stamping may change only the reported trailing i32 field, while
`$shapeBrand` may change only the reported trailing nullable-ref field and its
deterministic backward brand chain. The refresh is transactional and still
rejects removed types, unrelated layout drift, or graph expansion caused by
the non-reference stamping pass. This keeps the prepared type graph exact
through leaf finalization and DCE even when two differently named object
methods have physically colliding layouts.

The anti-vacuity fixture creates a captured numeric `valueOf` method and a
numeric `toString` fallback on two colliding shapes. Direct-body poison proves
the terminal and both lifted methods are IR-owned; GC and standalone validate
and return 43 with zero post-claim errors. The exact optimized binaries improve
from **3,066 to 2,912 bytes** in GC and from **1,485 to 1,268 bytes** in
standalone. Focused object-method plus existing #4208 OrdinaryToPrimitive
coverage is **11/11**.

The complete post-fix adjacent matrix is **83/83 across 11 files**. Full
equivalence reports **1,645 passing, 24 known failures, 12 baseline cases now
passing, and zero new regressions**. Cross-backend differential coverage is
**29/29**. Hybrid and strict IR-only shadows both remain **37/37 IR bodies, 0
legacy bodies, 0 Unsupported, and 0 Invariants**; typecheck, formatting,
fallback, optimization-retirement, oracle, issue-integrity, LOC-budget, and
function-budget gates are green.

String-returning method shorthand remains typed-direct: the current prepared
route is correct but its generic boxed standalone StringToNumber conversion is
454 bytes larger than direct in the focused fixture. It must gain a native
string-to-number IR intrinsic before admission. Property-assigned function
expressions retain #4208's existing open-object IR protocol; mixed method/data
and mixed shorthand/function forms remain direct. Object accessors,
receiver-sensitive methods, parameters, general method reads/calls, and wider
cross-owner escapes remain later R3 families. No direct object-method emitter
is deleted yet because those consumers remain live.

### Parameterized object-method call checkpoint (2026-08-13)

Receiver-insensitive method shorthand may now carry fixed number/boolean
parameters and use an arbitrary stable property name. The closed object keeps
the exact closure-valued field, and a direct `object.method(args)` expression
loads that field and emits the existing typed closure call. This preserves the
direct backend's static target: optimized output contains `call_ref` and no
generic `__call_m_*` dispatcher.

The GC and standalone anti-vacuity fixture captures an outer numeric offset,
passes a runtime argument through two methods, validates, and returns 43 in
both the direct and prepared builds. Direct-body poison proves the terminal
and both lifted object-method units are IR-owned with zero post-claim errors.
The optimized GC artifact improves from **2,855 to 2,827 bytes**; standalone
improves from **6,268 to 6,245 bytes**. The focused checkpoint is **4/4**, and
the object-method plus exact #4208 OrdinaryToPrimitive subset is **17/17**.
The adjacent closure/object/prepared ownership matrix is **82/82 across 11
files**. Full equivalence remains **1,645 passing, 24 known failures, 12
baseline cases now passing, and zero new regressions**; cross-backend
differential coverage is **29/29**. Hybrid and strict IR-only shadows remain
**37/37 IR bodies, 0 legacy bodies, 0 Unsupported, and 0 Invariants**.
Typecheck, formatting, and the fallback ratchet are green.

Receiver-sensitive methods remain direct because their call semantics require
installing the real `this` value. Mixed data/method and mixed
shorthand/function objects also remain direct until one closed representation
can preserve their complete property semantics. String-returning shorthand,
method reads/escapes, object accessors, and the general open-object surface are
still later R3 families. The two unrelated #4208 module/runtime-support suites
currently report the same **6 failures / 11 passes** on this checkpoint and its
clean parent, so they are recorded as baseline rather than attributed to this
slice.

### Object-method value checkpoint (2026-08-13)

An exact `const fn = object.method; fn(args)` sequence now retains the method's
closure signature through selection and call-graph closure. The receiver must
be a preceding checker-resolved const whose initializer is the already
certified all-shorthand method object; the alias must also be const. The
AST-to-IR builder already preserves the closure-valued field on property read,
so no new runtime representation or generic dispatch is needed.

Direct-body poison proves the terminal and lifted method remain IR-owned in GC
and standalone, both artifacts validate and return 42, and optimized output
uses `call_ref` with no `__call_m_*` dispatcher. The GC artifact improves from
**3,406 to 2,262 bytes**; standalone improves from **6,458 to 5,893 bytes**.
The focused direct-call/value/boundary suite is **7/7**, and the adjacent
closure/object/prepared ownership matrix is **85/85 across 11 files**. Full
equivalence remains **1,645 passing, 24 known failures, 12 baseline cases now
passing, and zero new regressions**; cross-backend differential coverage is
**29/29**. Hybrid and strict IR-only shadows remain **37/37 IR bodies, 0
legacy bodies, 0 Unsupported, and 0 Invariants**. Typecheck, formatting,
fallback, optimization-retirement, oracle, issue-integrity, LOC-budget, and
function-budget gates are green.

Mutable aliases remain a typed select-stage refusal; chained aliases,
callback/cross-owner escapes, receiver-sensitive methods, accessors, and
open-object method values remain later families.

## Exhaustive source-unit census

Before preparing any body, walk the source once in lexical/source order and
record one `IrUnitId` per executable source body. The census must distinguish:

1. Top-level and nested function declarations, including last-wins/Annex-B
   declarations without losing shadowed identities.
2. Function expressions, arrows, IIFEs, callback expressions, object-literal
   methods/getters/setters, and computed/private method bodies.
3. Class declarations and expressions at module, function, block, loop,
   switch, try/catch/finally, and expression positions.
4. Explicit constructors, synthesized default base/derived constructors,
   instance/static methods, and instance/static getter/setter pairs.
5. Instance field initializer expressions and parameter-property/default work;
   static field/block execution is inventoried here but its ordered
   `ModuleInitPlan` emission belongs to #3523.
6. Lifted closure bodies and nested functions produced from each parent.

Unsupported or ambient/abstract bodies are not omitted. Ambient/abstract
entries receive an explicit non-executable classification; executable but
unimplemented entries receive typed Unsupported. Inventory must equal terminal
outcomes before class/body emission.

## Source units versus support units

Do not equate generated Wasm functions with source bodies. Record explicit
support relationships:

- A source constructor is one source unit. For a WasmGC class,
  `<Class>_init` is that exact source-unit callable and executes
  field/default/source-constructor semantics. `<Class>_new` is an AST-free
  class support binding. The source body occurs only in `_init`, never in both.
- A default constructor receives a deterministic synthetic source-unit ID and
  support units derived from its `IrClassId`.
- Inherited member aliases point to a canonical parent unit/slot and are not a
  second body emission.
- Closure trampolines, wrapper structs, cache globals, host bridges, and
  method-call adapters are support units/bindings derived from the source unit.
  Their own emissions are counted, but they do not inflate the source-body
  denominator.
- Runtime provider bodies (Promise subclass bridges, coercion helpers, string/
  object/array providers) remain shared support code until R6. R3 plans typed
  calls to them; it does not copy or delete them.

## Preparation and ownership rules

1. Build class layouts, parent relationships, member signatures, field plans,
   descriptors, closure captures, and support intents into `ProgramAbiMap` /
   `PreparedIrProgram` before any class or closure body emitter runs.
2. Prepare a class ownership component atomically when its layouts,
   constructor/init chain, members, field initializers, nested closures, or
   inheritance edges cannot safely cross policies. One unsupported member may
   temporarily make the whole component direct, but that decision and every
   per-unit outcome are final before emission.
3. Prepared source bodies use only IR emission and planned support units.
   Unsupported components use the direct path once. No legacy class body is
   retained behind an IR patch.
4. A lifted/nested function failure is part of its parent component's typed
   preparation result. It cannot be discovered after the parent body shipped.
5. Replace the current selector/integration static mismatch with exhaustive
   reconciliation: `selected IDs == prepared IDs + typed failures`. A `continue`
   that drops a selected unit is an Invariant.
6. Preserve class evaluation and static initializer intents for #3523. R3
   plans their identities/layouts but does not reorder top-level execution.

## Bounded landing sequence

### Commit 1 — exhaustive census and class/closure ABI planning

- Add the source-unit walker and source/support-unit distinction.
- Move the planning half of `collectClassDeclaration` into typed class/layout/
  ABI data without compiling bodies.
- Inventory all nested/class-expression/object-method/closure positions and
  reconcile them with R0 outcomes.

### Commit 2 — Prepared class members and constructor support

- Prepare constructors, `_new`/`_init`, methods, getters/setters, fields,
  inheritance, and `super` call components.
- Implement static method/accessor signatures without `self`; close the
  selector-static/integration-skip hole.
- IR-emit Prepared components once; direct-emit Unsupported components once.

### Commit 3 — closures, nested units, and legacy-body bypass

- Prepare lifted functions, closure captures, object methods, and nested class
  units before emission.
- Route closure support through planned ABI bindings and exact counters.
- Bypass `compileClassBodies` / nested direct body compilation for every
  Prepared unit. Leave the direct implementation present for temporary
  Unsupported policy and R10 deletion.

## File ownership and locks

One developer owns `src/codegen/class-bodies.ts`,
`src/codegen/declarations.ts`, `src/codegen/closures.ts`, `src/ir/select.ts`,
`src/ir/from-ast.ts`, `src/ir/integration.ts`, and the Prepared-program modules
for the R3 landing. These files encode one class/closure component invariant
and must not be split between parallel implementation branches.

`src/ir/module-init.ts` and module-init/start wiring are reserved for #3523.
Runtime/builtin provider files are reserved for R6. Multi-source and linear
files remain R5/R8.

## Anti-vacuity tests

`tests/issue-3522-ir-class-compile-once.test.ts` must prove:

1. An explicit base constructor and derived constructor inventory one source
   body each. `_init` is the exact source callable and `_new` is distinct
   support; constructor/field code executes once and counters reconcile.
   Synthesized default constructors remain a follow-up family until they have
   an exact synthetic IR body rather than generic direct init compilation.
2. Instance/static methods with the same property name, instance/static
   getters/setters, and a top-level synthetic-key collision receive distinct
   IDs, slots, and correct receiver signatures.
3. A static method admitted by selection is Prepared and emitted; a test seam
   that restores the current integration `continue` fails reconciliation.
4. Fields, parameter defaults, `super(...)`, `super.method()`, overrides,
   inherited aliases, and multi-level local inheritance run like JavaScript on
   host, standalone, and WASI-relevant configurations.
5. Named/anonymous class expressions and class declarations nested in a
   function/block/loop/try inventory deterministically and capture the correct
   enclosing binding.
6. Function declarations, expressions, arrows, object methods/accessors,
   IIFEs, and lifted closures record one source outcome and one body emitter.
   A lifted build/verify failure is terminal before any parent body emission.
7. A Prepared class component has `direct=0, IR=1` for every source body. An
   Unsupported component has `direct=1, IR=0`; no unit has both or neither.
8. Static field/block intents are present in source order for #3523 but are not
   executed by a second R3 path.

Run adjacent coverage from `tests/issue-1983-funcmap-collision.test.ts`,
`tests/issue-3000-1b.test.ts`, `tests/issue-3000-e.test.ts`,
`tests/issue-3144-ir-class-claims.test.ts`, `tests/class-expressions.test.ts`,
`tests/nested-class-declarations.test.ts`, and closure equivalence suites.

## Acceptance criteria

- [ ] The single-source inventory is exhaustive for every executable function,
      class/member, field-initializer, object-method, nested, and closure body;
      inventory equals terminal outcomes before emission.
- [ ] Source units and synthetic support units have distinct structural IDs and
      counters. No constructor or inherited alias double-counts a source body.
- [ ] Constructors, `_new`/`_init`, instance/static methods, get/set, fields,
      inheritance, class expressions, nested declarations, object methods, and
      closures follow the Prepared-or-Unsupported compile-once rule.
- [ ] There is no selector-static/integration-skip hole and no selected unit can
      disappear through a `continue` or flat-name collision.
- [ ] Prepared class/closure bodies do not call legacy body compilers or patch
      legacy-created slots. Unsupported units remain one-pass direct only under
      the temporary hybrid policy.
- [ ] Class layouts/type indices/signatures and capture ABI are fully planned
      before bodies; late unplanned support is fatal.
- [ ] Runtime provider implementations remain shared and present for R6; R3
      deletes no behavior merely because a class body is IR-owned.
- [ ] Runtime/equivalence, cross-backend, standalone/WASI validity, full class/
      closure tests, and merge-group Test262 are net-non-negative.

## Risks and mitigations

- **Incomplete nested census:** class expressions, object methods, or lifted
  closures can remain invisible while common class tests pass. Reconcile the
  exhaustive source walk against terminal outcomes and add omission seams.
- **Constructor/support double execution:** `_new`, `_init`, field work, and
  the source constructor can overlap. Model one source unit with explicit
  support edges and assert source-body and support-emitter counts separately.
- **Class ABI/layout drift:** receiver signatures, inheritance, and type-index
  order are validation-sensitive. Freeze the entire class component in
  `ProgramAbiMap` and test legacy/IR boundary calls before emitting it.
- **Evaluation-order leakage into R4:** collecting static intents can execute or
  reorder them too early. R3 records immutable source ordinals only; #3523 is
  the sole owner of their execution.
- **Runtime-provider scope creep:** class/closure support may call shared
  runtime families. Record typed intents and retain providers for R6 instead of
  copying or deleting behavior in R3.

## Out of scope

- Ordered module-init execution, static field/block emission, live-binding
  seeds, TDZ/export/start/defer/WASI init policy (#3523).
- Cross-file/multi-source Prepared ownership (R5).
- Replacing runtime provider entry points with semantic intrinsics (R6).
- Async class/method/closure ownership beyond R7's policy, shared linear
  consumption (R8), escape-hatch removal (R9), or direct-handler deletion
  (#3090/R10).

## Required completion evidence

```bash
pnpm exec vitest run tests/issue-3522-ir-cross-owner-free-function.test.ts tests/issue-3522-ir-class-compile-once.test.ts tests/issue-3522-ir-static-class-method.test.ts tests/issue-3521-prepared-free-function-routing.test.ts tests/issue-1983-funcmap-collision.test.ts tests/issue-3000-1b.test.ts tests/issue-3000-e.test.ts tests/issue-3144-ir-class-claims.test.ts tests/class-expressions.test.ts tests/nested-class-declarations.test.ts --pool=forks --poolOptions.forks.singleFork=true --no-file-parallelism
pnpm run check:ir-only -- --policy=hybrid
pnpm run check:ir-only -- --policy=ir-only --json
pnpm run check:ir-fallbacks -- --verbose
pnpm run typecheck
pnpm run lint
pnpm run format:check
node scripts/equivalence-gate.mjs
pnpm exec vitest run tests/cross-backend-diff.test.ts --pool=forks --poolOptions.forks.singleFork=true --no-file-parallelism
```

The PR report must include the exhaustive source/support-unit census by kind,
class-component ownership decisions, the static-claim reconciliation table,
per-unit direct/IR emission counters, and runtime evidence for every listed
class/closure family. A green class sample with missing nested/static IDs is
vacuous and does not close R3.

### Incremental Function caller boundary repair (2026-08-13)

The merge-group Test262 rerun exposed that the exact ES5
`Function.caller` guard was sound only for a fresh TypeScript Program. The
production Test262 worker reuses an incremental Program, whose oracle may
return an equivalent declaration clone. Comparing that declaration by object
identity let `gNonStrict.caller` enter the Prepared function-value population,
where the new trampoline bypassed the direct caller-strictness hand-off.

The guard now compares original declaration identity as well as the current
node. An incremental-compiler fixture warms and reuses the Program before
compiling the exact strict-eval/sloppy-caller shape, then proves the function
remains direct and module initialization does not throw. Ordinary function
value targets are unaffected.

The next merge-group rerun exposed the complementary only-strict row
`built-ins/Function/15.3.5.4_2-11gs.js`. Incremental reuse can also return a
same-named declaration from a different prior source shape, so even structural
source-position comparison is not sufficient for the current function's
syntactic self-read. The guard now recognizes a same-name self receiver
conservatively. The observing function stays direct through that exact guard;
runtime-materialized sibling targets also stay direct because they share the
caller-activation hand-off, while unrelated direct-call-only functions remain
eligible for the ordinary IR overlay. This avoids relying on stale checker
identity without changing unrelated Test262 harness bodies. Focused incremental coverage pins
both complementary semantics: a strict eval in a sloppy script exposes its
non-strict caller without throwing, while an inherited-strict eval callback
must throw when the callee reads `caller`.

The broader every-top-level-function withdrawal was tried after the `11gs`
queue failure and removed after the next merged-state run regressed
`built-ins/Function/15.3.5.4_2-12gs.js`: it changed the Wasm for unrelated
harness callables and made the sloppy caller appear strict. The focused parity
fixture therefore carries a direct-call-only sibling and requires it to stay
IR-emitted beside the direct observing function and direct function-value
target; it is not withdrawn by the source-wide activation boundary.

### Native-first immediate call/apply parity repair (2026-08-13)

After the native-first host-import gate landed on main, the queued merge
exposed an optimization regression in the new singleton preparation. A local
function used only as the receiver of an immediately invoked `.call(...)` or
`.apply(...)` was retaining the complete generic closure bridge even though
the direct owner already lowers that invocation without a persistent runtime
function value. Each probe grew from a 43-byte, zero-import optimized module
to 7,289 bytes with three JS-string bridge imports.

The runtime-value census now excludes only those exact immediately invoked
receivers. The function body remains Prepared and IR-emitted with no legacy
body, while the existing optimized invocation route stays available to the
direct owner. Explicit `call` and `apply` parity fixtures execute the result,
require zero Wasm imports, and require the optimized IR binary to be no larger
than its direct-backend control. Both are 43 bytes after the repair, and the
native-first gate remains at 379 imports without increasing its baseline.

### Chained object-method value checkpoint (2026-08-13)

An exact callable projection now survives immutable local alias chains such as
`const add = operations.add; const alias = add; const invoke = alias`. The
selector copies the already-proven arity and return-class projection at each
`const` link, while the call-graph census recognizes the same source-ordered
links as intra-function closure values. AST-to-IR already carries the exact
closure SSA value through identifier reads, so this adds no wrapper, boxing,
generic dispatch, or new runtime representation.

Direct-body poison proves `run` remains IR-owned with `direct=0, IR=1` in GC
and standalone, the lifted object method stays in the same prepared component,
both artifacts validate and return 42, and WAT uses `call_ref` without a
`__call_m_*` dispatcher. Optimized GC remains **2,262 bytes versus 3,406
direct**; standalone remains **5,893 versus 6,458 direct**. A mutable link is
an explicit negative control and remains a select-stage
`call-resolution-unsupported` direct body. The focused object-method suite is
**10/10**.

### Callable-alias materialization guard (2026-08-13)

The immutable-alias checkpoint copies only projections whose source already
has a first-class IR value. A nested `function declaration` is different: its
selector projection describes a name-only direct-call target, and AST-to-IR
does not materialize a bare read of that declaration as an SSA closure value.
Copying that projection through `const alias = nestedFunction` therefore let
selection succeed before lowering failed with an internal invariant.

The alias gate now refuses that exact name-only source. A regression fixture
executes `const alias = add; alias(input)` through the direct body, requires a
typed select-stage `call-resolution-unsupported` outcome, and requires zero
post-claim errors. The valid object-method alias chain remains IR-owned and
the focused object-method suite is **11/11**.

The call-graph half now resolves every variable-backed callable by exact
declaration identity as well. Its former function-wide name set could treat a
later ambient call as local when an earlier block happened to declare a
same-named callable alias. The regression fixture combines a block-local
`parseInt` alias with a later ambient `parseInt("42")` call; the function now
falls back cleanly at selection and executes through the direct body with zero
post-claim errors. This keeps lexical scope and graph ownership aligned rather
than letting a name collision surface as a build invariant.

The closure-family parity fixtures now poison every expected lifted body as
well as its source owner, so a hidden direct compile followed by an IR patch
cannot satisfy the tests. They also compare the optimized import surfaces:
standalone remains zero-import, GC introduces no import absent from the direct
control (and commonly removes generic call/destructuring bridges), and the WAT
checks reject `__call_m_*` dispatch. All admitted fixtures retain runtime,
validation, exact IR ownership, and optimized-size parity.

### Destructured object-method value checkpoint (2026-08-13)

Exact object-method values may now flow through a const object binding pattern,
including renaming and immutable local alias chains: `const { add: selected } =
operations; const invoke = selected; invoke(input)`. The module-binding
resolver exposes the exact same-source value declaration for binding elements,
parameters, nested declarations, and variables, so the selector and local call
graph compare lexical identities instead of names. Incremental Programs retain
the established stable file/position identity fallback; a changed-snapshot
warm-up followed by fresh and reused target compiles produces byte-identical
artifacts and does not let a block-local destructured `parseInt` hide the later
ambient call.

The new projection is fail-closed and atomic. Every destructuring use of the
exact const all-method receiver must name represented own methods, the receiver
must be unwritten and unescaped, and each projected value/const-alias chain may
be used only by direct non-optional calls in the same lexical owner. Mixed or
inherited fields, sibling unsafe patterns, object aliases, property writes,
cross-owner captures, callback/value escapes, mutable links, and optional calls
stay on a typed select-stage direct body with zero post-claim errors. Optional
invocation is also rejected by the general call selector because AST-to-IR does
not lower `?.()` yet; a later valid projection can no longer expose that
pre-existing select/build mismatch.

Direct-body poison proves `run` and its lifted method are IR-owned with
`direct=0, IR=1` for both admitted patterns. Both optimized artifacts validate,
execute, use `call_ref`, and contain no `__call_m_*` dispatcher. Exact output
and import measurements are:

| Pattern | Target | Direct bytes | IR bytes | Direct imports | IR imports |
| --- | --- | ---: | ---: | --- | --- |
| `{ add }` | GC | 3,306 | 2,262 | box, throw-type-error, unbox | box, unbox |
| `{ add }` | standalone | 6,830 | 5,893 | none | none |
| `{ add: selected }` plus two const aliases | GC | 3,419 | 2,262 | box, generic-call/array, throw-type-error, unbox | box, unbox |
| `{ add: selected }` plus two const aliases | standalone | 6,830 | 5,893 | none | none |

The focused object-method suite is **24/24** and the adjacent six-file
closure/object matrix is **46/46**. Hybrid and strict IR-only shadow validation
remain **37/37 IR bodies, 0 legacy bodies, 0 Unsupported, and 0 Invariants**;
cross-backend differential coverage is **29/29**; the fallback ratchet has zero
unintended, post-claim, or module-level increases; and native-first host-import
policy remains **379 imports, 0 legacy-semantic, 0 unknown**. Typecheck,
formatting, LOC/function budgets, oracle, and coercion-site gates are green.
Full equivalence reports **1,645 passing, 24 known failures, 12 baseline cases
now passing, and zero new regressions**.

Remaining R3 boundary: cross-owner object-method values and general callable
escapes still require a planned capture/runtime-value ABI before admission.
Receiver-sensitive methods, accessors, mixed/open objects, optional calls, and
mutable callable fields remain explicit later families; their live direct
implementations cannot be deleted at this checkpoint.

### One-hop object-alias destructuring checkpoint (2026-08-13)

The destructuring-only projection now follows exactly one immutable local
object alias: `const copy = operations; const { add } = copy; add(input)`. The
root remains an exact preceding `const` all-method object literal, and both the
root and alias are resolved by declaration identity in the same lexical owner
and in source order. General property reads through aliases are deliberately
unchanged; this does not admit `copy.add` as a new callable-value family.

The proof is receiver-wide and fail-closed. It scans both identities and
permits exactly the selected root-to-alias edge plus represented own-method
destructures. Mutation through either name, a mutable or second alias, another
independent alias of the same root, escape, shorthand storage, nested capture,
unsafe sibling destructuring, computed access, optional invocation, an
unresolved checker reference, or changed-snapshot shadowing keeps the complete
function on the direct path with zero post-claim errors. A static binding key
whose spelling collides with the alias is correctly treated as a property key,
not a value read; `const { copy: invoke } = copy` is an explicit positive
control.

No AST-to-IR, Program ABI, runtime, or Wasm lowering change is needed. The
ordinary alias retains the same closed object SSA value, destructuring uses the
existing closure-valued `object.get`, and invocation remains a typed
`call_ref`. Direct-body poison proves the owner and lifted method are both
IR-emitted with no legacy body in GC and standalone. The focused suite is
**39/39** and the adjacent eight-file closure/object matrix is **77/77**.
Hybrid and strict IR-only shadow
validation remain **37/37 IR bodies, 0 legacy bodies, 0 Unsupported, and 0
Invariants**; the fallback ratchet remains clean with only the two existing
deferred string-builder candidates. Cross-backend differential coverage is
**29/29** and native-first host-import policy remains **379 imports, 0
legacy-semantic, and 0 unknown**. Full equivalence reports **1,645 passing, 24
known failures, 12 baseline cases now passing, and zero new regressions**.
Typecheck, lint, formatting, LOC/function budgets, oracle, coercion-site, issue,
and optimization-retirement gates are green.

Optimization parity is explicit rather than inferred. The admitted alias
artifact validates, returns 42, uses `call_ref`, contains no `__call_m_*`
dispatcher, and introduces no import absent from the direct control. GC keeps
exactly the box/unbox imports and standalone remains zero-import. In each
target the optimized IR binary is byte-for-byte identical to the equivalent
IR source without the object alias (**2,262 bytes GC; 5,893 standalone**) and
smaller than direct (**3,306 bytes GC; 6,830 standalone**), proving that the
source-level alias is erased without losing the existing optimization.

Next resumable R3 slice: migrate the existing destructured method captured by
a nested closure. The value flow and typed closure call already lower through
IR; the remaining preparation blocker is that `prepareClosureTransaction` does
not yet pass its `ClosureStructRegistry` while resolving closure-valued capture
fields. Bootstrap that registry, preserve the canonical closure wrapper-root
reference in the capture ABI, then convert the existing negative fixture with
poison/parity/size/import coverage. This should move one focused terminal body
from legacy to IR. Bare nested-function values, receiver-sensitive methods,
accessors, mutable callable slots, optional calls, and broader escapes remain
later families. No shared direct implementation has zero consumers at this
checkpoint, so none is deleted here.

### Captured object-method-value checkpoint (2026-08-14)

An exact object-method value, read either as `const add = operations.add` or
through destructuring, may now flow through an immutable local alias chain and
be captured by one immediately nested local closure. Both the method and the
capturing closure remain in the same Prepared component, and the outer
function may call that closure directly without retaining any legacy body.

The selector keeps this surface deliberately narrow. The capturing closure
must be an exact `const` arrow or function-expression initializer in the
destructuring owner's lexical scope, it must be called directly and
non-optionally after its declaration, and neither the method-value chain nor
the capture closure may escape. The whole binding pattern is limited to one
capture owner, not merely each projected method. Mutation, shadowing, two
capture owners, deeper nesting, callback passing, return or object-storage
escape, optional invocation, and mutable ref-cell capture all remain typed
select-stage fallbacks with zero post-claim failures. Direct-property and
destructured projections share this exact declaration/alias/owner proof, so a
deeper direct-property capture cannot pass selection and then fail during IR
planning. One admitted closure may capture multiple represented methods from
the same binding pattern, but distinct capture owners remain deferred.

`prepareClosureTransaction` now resolves closure-valued capture fields through
the transaction's existing `ClosureStructRegistry`. This is a bootstrap of the
already canonical registry, not a second type family: a capture field stores
the canonical wrapper-root reference, while the exact method wrapper remains
its allocation subtype. A deliberately non-vacuous fixture registers a live
boolean method family before the captured numeric method, poisons all four
direct bodies, and inspects WAT to prove that the numeric capture uses the
canonical root rather than the distinct numeric child wrapper. A second
heterogeneous fixture captures numeric and boolean methods in one closure and
proves that both capture fields use that same canonical root. Invocation is
still a typed `call_ref`; there is no generic dispatcher, `call_indirect`,
extern/any conversion, or new import surface.

The focused object-method suite is **58/58** and the adjacent eight-file
closure/object matrix is **96/96**. Both GC and standalone artifacts validate
and return 42. For the basic captured-method fixture, optimized GC is **2,262
bytes versus 3,423 direct** and optimized standalone is **5,893 versus 6,951
direct**. GC keeps exactly the number box/unbox imports; standalone remains
zero-import. The live wrapper-order fixture also requires optimized IR to be
no larger than direct and produces **3,053 bytes GC** and **6,223 bytes
standalone**. The two-field heterogeneous capture produces **2,964 bytes GC**
and **6,385 bytes standalone**, remains no larger than its direct controls,
and adds no imports beyond boolean/number boxing and numeric unboxing in GC;
standalone remains zero-import.

Hybrid and strict IR-only shadow validation remain **37/37 IR bodies, 0
legacy bodies, 0 Unsupported, and 0 Invariants**. The fallback ratchet has
zero unintended, post-claim, or module-level increases; cross-backend
differential coverage is **29/29**; and native-first host-import policy remains
**379 imports, 0 legacy-semantic, and 0 unknown**. Full equivalence reports
**1,645 passing, 24 known failures, 12 baseline cases now passing, and zero new
regressions**. Typecheck, lint, formatting, LOC/function budgets, oracle,
coercion-site, issue-integrity, IR-adoption, and optimization-retirement gates
are green.

Remaining boundary: multiple immediate capture owners, deeper cross-owner
flow, closure escapes, mutable captured callable cells, receiver-sensitive
methods, accessors, open or mutable method objects, and optional calls remain
direct. A pre-existing Program-ABI defect was exposed by an unused top-level
callable-parameter function: preparation can require an allocation wrapper
that DCE later removes even though only its call/carrier role is live. It does
not affect the physically used capture fixture and is not caused by this
slice. The size-preserving follow-up is usage-sensitive closure-support roles
(carrier, invoke, and allocate), not pinning every speculative prepared type.
No shared direct implementation has zero consumers here, so none is deleted in
this checkpoint.

Next resumable R3 slice: admit bounded sibling capture fan-out. Remove only the
one-owner cardinality limits while retaining the exact immediate-owner,
declaration-before-call, direct non-optional invocation, and no-escape proof
for every sibling. Promote both a shared numeric method captured by two local
closures and heterogeneous destructured methods captured by distinct local
closures, with every owner/method body poisoned and canonical-root, import,
runtime, and optimized-size parity in GC and standalone. The unused
callable-child-wrapper defect does not block that allocation-backed slice; it
must be repaired with usage-sensitive closure-support roles before
carrier/invoke-only callable passing is admitted.

### Bounded sibling method-capture checkpoint (2026-08-14)

The capture proof now admits any finite set of immediately nested local
closures that capture an exact object-method value. Each sibling is still an
exact `const` arrow or function-expression initializer in the projection
owner, declared before use, invoked only by a direct non-optional call in that
owner, and forbidden from escaping. Removing the former one-owner cardinality
limit does not admit deeper nesting, mutation, object storage, callback
passing, returns, or optional invocation.

Direct-property aliases and destructured aliases share the same proof. Three
GC/standalone fixtures cover a direct-property alias captured by two siblings,
a destructured alias captured by two siblings, and heterogeneous numeric and
boolean methods from one destructuring pattern captured by distinct siblings.
They poison every physical body (four, four, and five bodies respectively),
require exact IR function inventories with no legacy body or post-claim
demotion, validate and return 42, and inspect each sibling's typed `call_ref`.
The heterogeneous fixture additionally proves that both capture subtypes store
the canonical callable wrapper-root reference despite their distinct physical
signatures. Identical sibling layouts deduplicate to one closure subtype rather
than growing the type graph. Another fixture gives the object method its own
readonly numeric capture before two siblings capture that concrete method
closure, proving that canonical-root fields safely carry a captured allocation
subtype. A changed-snapshot incremental fixture warms the compiler with an
escaped sibling, then proves fresh, warmed, and reused safe artifacts have
exact body inventories and byte-identical binaries; a mixed safe/escaped
sibling fixture proves the projection remains atomic. There is no generic
dispatcher, `call_indirect`, extern/any conversion, or new import surface.

The focused object-method suite is **65/65** and the adjacent eight-file
closure/object matrix is **103/103**. Optimization parity remains explicit:

| Pattern | Target | Direct bytes | IR bytes | IR imports |
| --- | --- | ---: | ---: | --- |
| direct-property alias, two siblings | GC | 3,653 | 2,282 | box/unbox number |
| direct-property alias, two siblings | standalone | 7,066 | 5,913 | none |
| destructured alias, two siblings | GC | 3,659 | 2,282 | box/unbox number |
| destructured alias, two siblings | standalone | 7,066 | 5,913 | none |
| heterogeneous pattern, two siblings | GC | 4,362 | 2,827 | box boolean/number, unbox number |
| heterogeneous pattern, two siblings | standalone | 7,707 | 6,245 | none |

Hybrid and strict IR-only shadow validation remain **37/37 IR bodies, 0
legacy bodies, 0 Unsupported, and 0 Invariants**. The fallback ratchet remains
clean with only the two unchanged deferred string-builder candidates;
cross-backend differential coverage is **29/29**; and native-first host-import
policy remains **379 imports, 0 legacy-semantic, and 0 unknown**. LOC/function
budgets, oracle, coercion-site, issue-integrity, IR-adoption, and
optimization-retirement gates are green. Full equivalence remains **1,645
passing, 24 known failures, 12 baseline improvements, and zero new
regressions**.

The unused call-only child-wrapper/DCE defect remains outside this
allocation-backed slice. Carrier/invoke-only callable passing still requires
usage-sensitive closure-support roles before admission. Deeper cross-owner
flows, closure escapes, mutable callable ref cells, receiver-sensitive methods,
accessors, open or mutable objects, and optional calls remain direct. No shared
legacy implementation has zero consumers at this checkpoint, so none is
deleted here.

### Usage-sensitive closure support and bounded callable pass checkpoint (2026-08-14)

Closure-support preparation now records the strongest physical role that final
IR actually uses. Internal closure carriers retain only the canonical wrapper
root, invocation retains the root plus its exact lifted function type, and
allocation/capture retains the complete signature wrapper and captured subtype.
Callable source boundaries remain externref and publish an identity-exact empty
carrier proof. Missing support still fails closed, and an empty proof is valid
only for a callable carrier: closure, boxed, and object types still require
nonempty support refs.

The Program ABI planner unions repeated requests by semantic signature/layout
before its sorted canonical batch. It does not publish unused allocation
wrappers as required slots, so DCE can remove speculative child types without
weakening exact prepared-layout remap checks or growing binaries. A regression
with two unreachable invoke-only callable signatures now passes in GC and
standalone with optimization both off and on. The three bodies are poisoned,
all three IR bodies emit with zero legacy bodies/post-claim errors, Wasm
validates, `run(40)` returns 42, standalone remains zero-import, and optimized
IR has no new imports and is no larger than direct.

Semantically distinct signatures that share one physical Wasm function type
reuse the already planned type binding rather than claiming the allocator
object twice. A direct Program ABI regression uses signed and unsigned `i32`
signature facts—which erase to the same physical lifted type—to prove the
single required type slot is retained and remapped through one canonical
binding.

The same repair makes the pre-existing boolean callback fixture execute again:
the canonical root is no longer mistaken for two allocating semantic
signatures when one role is invoke-only. Its two stale void-callback assertions
now match the already-landed zero-result-signature contract: the signature is
expressible, while the value-position call still rejects at the call-graph
boundary.

That support repair unlocks one bounded captured-method handoff. An exact
captured method closure may be passed once to an immediately declared `const`
arrow/function expression when the matching required FunctionTypeNode
parameter is invoked directly, the signatures are identical, the source has
no defaulted parameters, and the consumer has exactly that one outer call. A
captured closure may cross at most one such handoff. The local boundary stays
compiler-internal closure-to-closure; it does not add an externref pack/unpack
round trip. Source-boundary callables remain externref and cannot enter this
path. Explicit negatives cover a callback parameter, a returned callable, an
object-method consumer, mixed internal/external call sites, and a top-level
function value; all compile and run by value with clean select-stage fallback,
and the mixed case emits no IR consumer body. A poisoned four-body fixture
(`run`, method, captured `invoke`, and `consume`) emits entirely through IR in
GC and standalone, validates, returns 42, adds no imports, and keeps the
optimized IR binary no larger than direct.

The proof remains deliberately atomic. A second callable forwarding hop,
callable return, object storage, deeper owner, mutation, alias escape, or
optional invocation stays on the direct path; focused negatives cover the new
relay and return boundaries beside the existing escape/optional corpus. No
shared legacy implementation has zero remaining consumers in this checkpoint,
so no direct implementation is deleted yet.

The five focused callable/support/object files pass **141/141**, including the
**70/70** object-method suite and **30/30** callable/Program ABI tests. The
adjacent eight-family closure/object matrix passes **108/108**. Hybrid IR-only
shadow validation remains **37/37 IR bodies, 0 legacy bodies, 0 Unsupported,
and 0 Invariants**. The fallback ratchet has zero unintended, post-claim, or
module-level increases and only the two unchanged deferred string-builder
candidates. Native-first host-import policy remains **379 imports, 0
legacy-semantic, and 0 unknown**. Full equivalence remains **1,645 passing, 24
known failures, 12 baseline improvements, and zero new regressions**.
The committed optimization-retirement census is also asserted at its current
**46 rows, 32 IR-owned, 3 retirement-ready, and 2 source-anchored** state; its
fail-closed `--require-ready` check reports the remaining **43/46** rows.

Next resumable R3 slices, in order: bounded callable return/escape where an
exact ownership proof can keep the value internal; transitive capture plumbing
for deeper nested owners; mutable callable ref-cell support; then
receiver-sensitive/accessor/open-object methods. Each slice must keep the same
runtime, import, optimized-size, IR-only shadow, and direct-optimization parity
requirements before retiring its obsolete direct consumer.

### Class-family measurement (2026-08-15)

Measured on `origin/main` `92f78620` before any code change, through the
production `compile` seam with `experimentalIR: true, trackIrOutcomes: true`
(target `gc`). `legacy`/`ir` count terminal outcomes with `legacyBodyEmitted` /
`irBodyEmitted`. The bare-selector seam (`planIrFallbackGateEntry`, the
fallback ratchet's planner) is **not** usable for this family: it is not
handed `projectedClassShapesById`, so every nested class reads as
`body-shape-rejected [nontail-class-unprepared]` there, including shapes that
demonstrably claim in production. Only terminal outcomes are evidence here.

| #   | Shape                                                | legacy | ir  | Terminal verdict                                                        |
| --- | ---------------------------------------------------- | -----: | --: | ----------------------------------------------------------------------- |
| N1  | nested class decl, explicit ctor + 1 method          |      0 |   3 | claims (control)                                                        |
| N2  | nested class decl, **implicit ctor**, 1 method       |      1 |   0 | `body-shape-rejected@select` on the owner; members never inventoried    |
| N3  | nested class decl, explicit ctor, **no method**      |      1 |   0 | `body-shape-rejected@select`                                            |
| N4  | nested class decl, implicit ctor, no method          |      1 |   0 | `body-shape-rejected@select`                                            |
| N5  | **two** nested classes, ctor + method each           |      0 |   5 | claims                                                                  |
| N6  | **three** nested classes, ctor + method each         |      0 |   7 | claims                                                                  |
| N7  | two nested classes, one with implicit ctor           |      3 |   0 | whole owner withdraws atomically                                        |
| N8  | nested class **expression**, explicit ctor + method  |      0 |   3 | claims (control)                                                        |
| N9  | nested class **expression**, **implicit ctor**       |      1 |   0 | `body-shape-rejected@select`                                            |
| N10 | nested class decl, ctor + two methods                |      0 |   4 | claims                                                                  |
| N11 | nested classes in two different functions            |      0 |   6 | claims                                                                  |
| N12 | nested class with a static method                    |      1 |   0 | `body-shape-rejected@select`                                            |
| N13 | nested class with an initialized field               |      1 |   0 | `body-shape-rejected@select`                                            |
| N14 | nested class with heritage (both nested)             |      3 |   0 | `body-shape-rejected@select`                                            |
| N15 | **top-level** class, implicit ctor, 1 method         |      0 |   2 | claims (capability control)                                             |
| N16 | top-level two classes, ctor + method each            |      0 |   5 | claims                                                                  |

Adjacent class-family shapes measured in the same run, for completeness:

| Shape                                            | Terminal verdict                                                                                                                          |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| top-level class expression `const C = class {…}` | `body-shape-rejected` on owner **and** `<module-init>`; members `class-member-unsupported`. Bare-selector arm `expr-new-module-binding-callee:Identifier` |
| named top-level `const C = class Inner {…}`      | same                                                                                                                                      |
| computed method name `["get"]()`                 | `class-method@select`                                                                                                                     |
| generator method `*gen()`                        | `class-member-unsupported@select`                                                                                                         |
| static `super.make()`                            | `class-method@select` on the caller; owner then `late-preparation-unsupported@resolve`                                                     |
| subclass of builtin (`extends Error`)            | `class-projection-unsupported@select`                                                                                                     |
| class with a static field                        | `static-class-initialization@select` on `<module-init>`                                                                                   |
| top-level `this`-free helper                     | claims (no residual — the `unattributed-arm:helper-internal` row in the matrix is stale)                                                   |

**Cardinality is not a limit.** N5/N6/N11 disprove the "one nested class per
function" hypothesis outright; the bounded nested-class transaction already
admits any finite number of them. The real gate is per-class member shape.

**Chosen family: nested classes with an IMPLICIT constructor** (N2 and N9 —
both the declaration and the exact `const C = class {…}` expression form).
Rationale:

- It is the single most common ordinary class shape — a class with only
  methods — and it costs the **whole enclosing function** plus every member,
  not just the constructor: N2/N9 withdraw `run` entirely and never inventory
  the members at all. N7 shows one implicit-ctor sibling withdraws an
  otherwise complete two-class component.
- The capability already exists and is proven: N15 is the same class shape at
  top level and compiles once today through the 2026-08-12 plain
  implicit-constructor checkpoint. Nothing about the `_new`/`_init` support
  pair, the AST-free allocation wrapper, or the layout ABI is missing.
- Both barriers are narrow structural gates, not absent lowering:
  1. `src/ir/class-accessor-safety.ts::isBoundedPreparedNestedOrdinaryClass`
     ends in `constructorCount === 1 && methodCount > 0`, so an implicit
     constructor fails the bounded-class predicate outright.
  2. `src/codegen/ir-plain-implicit-constructors.ts` restricts its support
     population to `declaration.parent === input.sourceFile` (in both the
     `new`-scan and the ancestor walk) and to `ts.isClassDeclaration`, so a
     nested declaration or a class expression can never be staged.
- It does **not** widen shadow-identity inheritance. The bounded predicate
  keeps `heritageClauses` rejected (N14 stays direct), so the #4448 shadow-shape
  surface is untouched by construction. Negative tests pin that explicitly.

Rejected alternative: top-level class expressions. The apparent gain is
similar, but the barrier is module-global binding ABI plus `<module-init>`
ownership (`expr-new-module-binding-callee`), which the cross-owner checkpoint
already deferred ("Module globals also remain deferred"). That is a different
and materially larger surface than a per-class member-shape gate.

### Nested implicit-constructor checkpoint (2026-08-15)

The chosen family now compiles once. A bounded nested ordinary class whose
constructor is IMPLICIT — in both the declaration and the exact
`const C = class { … }` expression form — is prepared with the same
`_new`/`_init` support pair that the 2026-08-12 plain implicit-constructor
checkpoint established at top level. No new lowering, ABI, runtime
representation, or import surface is introduced; the slice removes
top-level-only assumptions from five exact gates.

Measured terminal deltas (production `compile`, identical on `gc` and
`standalone`):

| Fixture                                            | Before        | After         |
| -------------------------------------------------- | ------------- | ------------- |
| nested decl, implicit ctor, one method (N2)        | legacy=1 ir=0 | legacy=0 ir=2 |
| nested class expression, implicit ctor (N9)        | legacy=1 ir=0 | legacy=0 ir=2 |
| two nested classes, one implicit-ctor sibling (N7) | legacy=3 ir=0 | legacy=0 ir=4 |

N7 is the load-bearing one: a single implicit-constructor sibling previously
withdrew an otherwise complete two-class component, so the gain is the whole
enclosing owner plus every member, not one constructor.

The five gates and what each now checks:

1. `isBoundedPreparedNestedOrdinaryClass` accepted `constructorCount === 1`;
   it now accepts `<= 1`. Heritage remains rejected, so an implicit DERIVED
   constructor is unreachable from this admission.
2. `prepareImplicitConstructorSupports` admitted only class DECLARATIONS whose
   parent is the source file. It now also admits a bounded nested class,
   resolving the expression form through its immutable `const` binding.
3. The Program ABI registry, the session recorder, and the support-draft
   predicate each asserted `terminalOwnerId === null`. The preparer proves the
   containing terminal owner is in the same transaction and passes that
   identity through the support contract, so each guard VERIFIES the exact
   nesting claimed rather than assuming absence — and still fails closed
   (`unplanned-abi-binding`) for a unit this transaction did not prepare.
4. The direct-body skip audit asserted the same, and now cross-checks that a
   nested skip belongs to the admitted bounded family.
5. The dependency sealer routed a nested implicit `_init` to
   `recordUnitReference`, which demands a post-pass IR function that an
   AST-free support body never has.

Gate 5 carried a real trap worth recording. The obvious relaxation — accepting
any `class-implicit-constructor` — regressed four passing tests, because the
correct discriminant is **non-terminality, not a null terminal owner**. Since
the #4402 initialized-field checkpoint an implicit constructor with initialized
instance fields is an ORDINARY TERMINAL class-member owner with a real source
body, and it must keep flowing through `recordUnitReference`. The old
`terminalOwnerId === null` test conflated the two cases: it excluded terminal
initialized-field constructors and genuine nested support for the same
incidental reason. The sealer now tests terminal membership directly. Found by
A/B against the pre-change tree — the same four tests fail with the naive
relaxation and pass without it.

Every measured negative boundary is preserved, verified rather than assumed:
a static member, an initialized instance field, heritage, a class with no
method, a `let`-bound class expression, and a method capturing the enclosing
frame all keep the complete owner direct with zero post-claim errors. The
heritage case is the explicit #4448 guard — the bounded predicate rejects
heritage, so no shadow-identity inheritance surface moves. A name-shadowing
fixture additionally proves an inner `Box` and an outer `Box` keep distinct
identities and runtime behaviour.

Coverage is `tests/issue-3522-nested-implicit-constructor.test.ts`, **20/20**
on `gc` and `standalone`: direct class/function body poison on every expected
body, exact terminal outcomes, one shared prepared component, Wasm validation,
runtime results, WAT proof that the prepared owner has no `call_ref`,
`call_indirect`, `ref.test`, ambient `this`, boxing, or `__call_m_*`
dispatcher, dual-run legacy↔IR equality, and optimized-size parity (IR never
larger than the direct control). A positive control proves the poison seam is
live, so the admitted-family assertions cannot pass vacuously.

Gates: focused nested/class-expression/static/class-expression suites
**34/34**; `check:ir-fallbacks` no unintended, post-claim, or module-level
increases (only the two unchanged deferred string-builder candidates);
`check:ir-only` single-host **37/37 IR-emitted, 0 legacy, 0 Unsupported, 0
Invariant, READY** with the standalone floor gate green;
`gen-ir-adoption --check` byte-clean after refreshing the `ClassDeclaration`
row; typecheck and formatting green.

Two pre-existing conditions were measured and are NOT caused by this slice.
`tests/issue-3522-ir-class-compile-once.test.ts` has **2 failures on the
unmodified base** ("keeps constructor receiver accessors on the direct dispatch
path", gc and standalone); the file is 40/42 before and after. Separately, a
class expression emits both `<binding>_*` and dead `__anonClass_N_*` functions
— present identically for the already-claiming explicit-constructor control on
base, so it is pre-existing duplication in the legacy naming path, not a
regression here.

Remaining nested class-family boundaries, in the order their surfaces grow:
statics and initialized fields on nested classes (each needs its ordered
definition-evaluation contract represented), nested heritage, and then
top-level class expressions with their module-global binding ABI.

### Class-family RE-measurement (2026-08-15, post-#4576)

Re-run of the family probes on `origin/main` `793b5c0e` — after the nested
implicit-constructor slice (#4576) and the #4448/#4575 selector fixes landed —
through the production `compile` seam with `experimentalIR: true,
trackIrOutcomes: true`. The `[skipped]` bare-selector caveat from the
2026-08-15 measurement still holds: terminal outcomes are the only evidence.

| Shape                                                        | legacy | ir  | Terminal verdict on current main                                       |
| ------------------------------------------------------------ | -----: | --: | ---------------------------------------------------------------------- |
| N2 nested decl, implicit ctor, 1 method                       |      0 |   3 | claims — #4576 confirmed still landed                                  |
| N9 nested class expression, implicit ctor                     |      0 |   3 | claims — #4576 confirmed still landed                                  |
| N1 nested decl, explicit ctor + method (control)              |      0 |   4 | claims                                                                 |
| N3 nested decl, explicit ctor, NO method                      |      2 |   0 | `body-shape-rejected` — predicate needs `methodCount > 0`              |
| N12 nested class, static method                               |      2 |   0 | `body-shape-rejected`                                                  |
| N13/NF1 nested class, initialized field                       |      2 |   0 | `body-shape-rejected`                                                  |
| N14 nested class, heritage                                    |      4 |   0 | `body-shape-rejected`                                                  |
| **A2 nested class, implicit ctor, getter**                    |  **3** | 0   | **`body-shape-rejected` — owner + every member withdrawn**             |
| **N-SET nested, implicit ctor, getter + setter (`this`)**     |  **4** | 0   | **`body-shape-rejected`**                                              |
| **N-MIX nested, implicit ctor, method + getter**              |  **3** | 0   | **`body-shape-rejected`**                                              |
| **N-MIX-CTOR nested, EXPLICIT ctor, method + getter**         |  **3** | 0   | **`body-shape-rejected` — the accessor alone withdraws it**            |
| **N-EXPR-MIX nested class EXPRESSION, method + getter**       |  **3** | 0   | **`body-shape-rejected`**                                              |
| E0 top-level class decl, ctor + method (control)              |      0 |   3 | claims                                                                 |
| A1 top-level class, ctor + getter                             |      0 |   3 | **claims — the capability control for accessors**                      |
| TL-SET top-level class, getter + setter reading `this`        |      0 |   4 | **claims**                                                             |
| TL-IF top-level class, initialized instance field             |      0 |   3 | claims (#4402)                                                         |
| TL-IF-IMP top-level, init field, implicit ctor                |      0 |   3 | claims                                                                 |
| TL-HER top-level class heritage                               |      0 |   5 | claims                                                                 |
| F2 top-level class, static METHOD                             |      0 |   4 | claims                                                                 |
| E1 top-level `const C = class { ctor + method }`              |      4 |   0 | `body-shape-rejected` on owner AND `<module-init>`; members unsupported |
| E2 top-level `const C = class { method only }`                |      3 |   0 | same                                                                   |
| E3 top-level `const C = class Inner { … }`                    |      4 |   0 | same                                                                   |
| C1 computed method name `["get"]()`                           |      2 |   1 | `class-method@select` on the member; owner `body-shape-rejected`       |
| C2 generator method `*gen()`                                  |      2 |   1 | `class-member-unsupported@select`                                      |
| S1 static `super.make()`                                      |      2 |   3 | `class-method@select`; caller `late-preparation-unsupported@resolve`   |
| B1 `class extends Error`                                      |      3 |   0 | `class-projection-unsupported@select`                                  |
| F1 top-level class, static FIELD                              |      3 |   1 | `static-class-initialization@select` on `<module-init>`                |
| TL-ACC-ONLY top-level, implicit ctor, getter ONLY             |      2 |   0 | `class-member-unsupported@select` (writeback ABI, see below)           |
| N-GET-ONLY nested, implicit ctor, getter ONLY, `this`-free    |      3 |   0 | `class-member-unsupported@select` (writeback ABI, see below)           |

Two rows of the prior table are now stale and are corrected here: the epic's
adjacent-shapes table recorded `static super.make()` and the computed-name row
without their partial claims, and `class with a static field` as a pure
`<module-init>` rejection — F1 in fact claims `Box_new` and loses the other
three units.

**Chosen family: instance GET/SET ACCESSORS on bounded nested ordinary
classes** (declaration and `const C = class { … }` expression form, implicit or
explicit constructor, `this`-reading bodies). Rationale:

- **Largest measured gain among the narrow candidates.** Five distinct
  fixtures, each losing 3–5 units — the whole enclosing function plus every
  member, not one accessor. The competing narrow families cost 2 units each
  (N3, N12, N13, NS1, NF1) and the partial ones (C1/C2/S1/F1) lose 2–3 while
  already claiming part of the class.
- **The capability is proven, not absent.** A1 and TL-SET are the controls: a
  numeric getter, and a getter/setter pair reading and writing `this`, compile
  once today at top level through the ordinary member path. No lowering, ABI,
  runtime representation, or import surface is missing.
- **The barrier is two structural gates, measured by bisection**, not one:
  1. `isBoundedPreparedNestedOrdinaryClass` counted only `ts.isMethodDeclaration`
     members, so an accessor fell through to the catch-all `return false` and
     the class never entered `localClasses` — which is what made the OWNER read
     `nontail-class-unprepared:ClassDeclaration` at `select.ts`.
  2. Relaxing gate 1 alone moved every fixture from `body-shape-rejected` to
     `class-member-unsupported` and claimed nothing. `exactAccessorClass` was
     `nestedClass || boundedTopLevelAccessorClass`, forcing every nested
     accessor onto the accessor-only WRITEBACK ABI —
     `boundedNestedAccessorAbiEvidence` admits string-returning getters and
     `dynamic` setters ONLY, so a numeric getter had no evidence and withdrew
     the whole atom.
- **It does not widen shadow-identity inheritance (#4448/#4575).** The bounded
  predicate still rejects `heritageClauses`, so no inheritance surface moves by
  construction; negative tests pin heritage, statics, initialized fields and
  name shadowing.

Rejected alternative: top-level class expressions (E1–E3). The measured gain is
comparable but the barrier is module-global binding ABI plus `<module-init>`
ownership (`expr-new-module-binding-callee`), which the cross-owner checkpoint
already deferred — a materially larger surface than a member-shape gate, and
unchanged since the previous slice reached the same conclusion.

### Slice record — nested class instance ACCESSORS (2026-08-15)

Landed as three source edits, each isolated by bisection against the measured
barrier above; no lowering, ABI, runtime representation, or import surface was
added, because the capability was already proven at top level (controls A1 and
TL-SET).

1. `isBoundedPreparedNestedOrdinaryClass` (`src/ir/class-accessor-safety.ts`)
   counts a `callableMemberCount` instead of a `methodCount`, admitting
   `GetAccessorDeclaration`/`SetAccessorDeclaration` under exactly the member
   shape methods already carry — non-static, undecorated, identifier-named,
   body-bearing, non-abstract, fixed-arity (getter zero parameters, setter
   exactly one plain parameter). `heritageClauses` stays rejected, so the
   predicate cannot reach an implicit derived constructor and no
   shadow-identity inheritance surface moves (#4448/#4575).
2. `exactAccessorClass` (`src/ir/select-identity.ts`) narrows from
   `nestedClass || boundedTopLevelAccessorClass` to
   `(nestedClass && boundedAccessorClass) || boundedTopLevelAccessorClass`.
   This is behaviour-preserving on the pre-slice tree — before accessors joined
   the ordinary family, a nested class reaching that loop WITH an accessor was
   necessarily accessor-only — and it routes an accessor on a bounded nested
   ORDINARY class down the ordinary descriptor-by-name-and-kind path instead of
   the accessor-only WRITEBACK ABI, whose
   `boundedNestedAccessorAbiEvidence` admits string-returning getters and
   `dynamic` setters ONLY and therefore had no evidence for a numeric getter.
3. The atomicity count in the same file now counts exactly the body-bearing
   callables the admitting predicate counted. Counting only ctor+methods left
   every accessor claim pending, which withdrew the whole class on arrival —
   this is why relaxing gate 1 alone moved every fixture from
   `body-shape-rejected` to `class-member-unsupported` and claimed nothing.

Coverage is `tests/issue-3522-nested-class-accessor.test.ts`, **26/26** on `gc`
and `standalone`: a nested method+getter declaration, a getter/setter pair that
reads and writes `this`, a nested class EXPRESSION with an accessor, an
explicit-constructor class whose getter reads a field, and two sibling accessor
classes as one shared prepared component — each with direct class/function body
poison on every expected body, exact terminal outcomes, Wasm validation,
runtime results cross-checked against node, WAT proof that the prepared owner
carries no `call_ref`, `call_indirect`, `ref.test`, ambient `this`, boxing or
`__call_m_*` dispatcher, dual-run legacy↔IR equality, setter evaluation ORDER
pinned against the direct path, and optimized-size parity (IR never larger than
the direct control). Nine negative boundaries are verified rather than assumed:
heritage (the explicit #4448 guard), a static accessor, a computed accessor
name, an initialized instance field, a `let`-bound class expression, an
accessor capturing the enclosing frame, the pre-existing accessor-only
WRITEBACK family still claiming unchanged, an inner accessor class keeping its
OWN identity when it shadows an outer name, and a positive control proving the
direct class-body emitter is still reached — so the admitted-family assertions
cannot pass vacuously.

Gates: `check:ir-fallbacks --verbose` OK, no unintended, post-claim or
module-level increases (only the two unchanged deferred string-builder
candidates); `check:ir-only --policy=hybrid` **READY**;
`check:ir-only --policy=ir-only --json` single-host **37/37 terminal units,
37 IR-emitted, 0 legacy bodies, 0 Unsupported, 0 Invariants**, standalone lane
at its baseline readiness with `"failures": []` (every entry/terminal-unit/
emitted/IR-body floor green); `gen-ir-adoption --check` byte-clean after
refreshing the `ClassDeclaration`, `GetAccessorDeclaration` and
`SetAccessorDeclaration` rows; `cross-backend-diff` **29/29**; typecheck, lint
and `format:check` green. `scripts/equivalence-gate.mjs` — **no new
equivalence regressions**, 1,661 passing / 24 failing against 36
known-failures. It additionally reports 12 baseline failures now PASSING
(`coercion-arithmetic-add` string concatenation ×8, `symbol-basic` ×2,
`issue-1197`, `math-pow-test262-pattern`); those come from the `origin/main`
merge, not from this slice, so the baseline ratchet (`--update`) is left to the
lanes that fixed them rather than folded into this PR.

**Seven failures in the epic's required suite list are NOT caused by this
slice, and they split into two groups — both attributed by A/B, not assumed.**
Reverting only `src/ir/class-accessor-safety.ts` and `src/ir/select-identity.ts`
to their `origin/main` contents reproduces all seven identically
(`issue-3521-prepared-free-function-routing` binary-size bound 33807 > 33723;
`issue-3522-ir-cross-owner-free-function` unsupported-console parity control
and mutable-class-layout control; `issue-3522-ir-class-compile-once`
constructor receiver ACCESSORS direct path ×2 and constructor receiver CALLS
virtual-dispatch direct path ×2).

- **Five are pre-existing at this branch's base `793b5c0e`** — the same
  src-only checkout there fails the same five. The two accessor-direct-path
  ones are the identical pair the previous slice recorded as base failures.
- **Two are a NEW main-side regression**, bisected by src-only checkout of the
  first-parent merges: `keeps constructor receiver calls on the
  virtual-dispatch direct path` (gc and standalone) PASSES at `60d1db4f`
  (#4583) and `f2058918` (#4582) and FAILS at `6df0fec6` (**#4589 / #4459
  value-discard**). Symptom: the DIRECT control acquires an
  `irPostClaimErrors` entry — "prepared owner …:top-level-function:0 has
  incomplete dependencies: foreign-source-unit … belongs to non-candidate
  terminal …; unplanned-abi-binding … has no resolvable Program ABI binding".
  Reported to the lead; it is a `#4459` follow-up, not a `#3522` one.

Remaining nested class-family boundaries are unchanged in order: statics and
initialized fields on nested classes (each needs its ordered
definition-evaluation contract represented), computed member names, nested
heritage, and then top-level class expressions with their module-global binding
ABI.

### Slice record — nested class INITIALIZED INSTANCE FIELDS (2026-08-16)

The next family in the order above, taking the initialized-field half. Statics
are **not** in this slice: measured, they hit a hard sealing-order invariant
(below), which is a materially larger transaction than a member-shape gate.

Measured on `origin/main` `49df493a` before any change, through the production
`compile` seam with `experimentalIR: true, trackIrOutcomes: true`, and again
after. Every row is identical on `gc` and `standalone`, and every `run=` value
was cross-checked against the same program in node.

| Fixture                                                | Before        | After         | run |
| ------------------------------------------------------ | ------------- | ------------- | --- |
| nested decl, IMPLICIT ctor, `p: number = 40`           | legacy=1 ir=0 | legacy=0 ir=3 | 42  |
| nested decl, EXPLICIT ctor, field + ctor-body ordering | legacy=1 ir=0 | legacy=0 ir=3 | 40100 |
| nested class EXPRESSION, implicit ctor, field          | legacy=1 ir=0 | legacy=0 ir=3 | 42  |
| nested decl, TWO initialized fields                    | legacy=1 ir=0 | legacy=0 ir=3 | 12  |
| nested decl, STRING-carrier field                      | legacy=1 ir=0 | legacy=0 ir=3 | 3   |

The gain is the whole enclosing function plus every member: before the slice
the owner read `body-shape-rejected@select` and the members were never
inventoried at all.

Three source edits, each isolated by bisection against the measured barrier:

1. `isBoundedPreparedNestedOrdinaryClass` (`src/ir/class-accessor-safety.ts`)
   rejected any property with an initializer. It now admits one whose
   initializer carries no CALL EDGE (`boundedPreparedInstanceFieldInitializer`:
   no call, `new`, tagged template, nested executable, or `super`). STATIC
   fields stay rejected — their initializer runs at class-definition time IN
   the containing frame, which is exactly the inertness the predicate asserts,
   so they are a different ordered contract.
2. `identity.ts` promotes a nested implicit constructor **with** initialized
   fields to a TERMINAL `class-implicit-constructor` unit, as top level already
   does since #4402, and gives the field-initializer support units that
   terminal as their owner. Relaxing gate 1 alone was **not** enough and was
   worse than the base: the member claimed while the owner failed
   `late-preparation-unsupported@resolve` — a split-ownership state R3 exists
   to prevent. A nested implicit constructor with NO initialized fields is
   untouched and stays a support unit (#4576).
3. `selectImplicitConstructorClaim` (`src/ir/select-identity.ts`) required
   `topLevelSourceClass`; it now also accepts a bounded nested source class.

**The call-edge gate is load-bearing, not conservatism.** A nested class's
field-initializer support unit is attributed to the containing executable while
the constructor terminal that ultimately runs the initializer is attributed to
the class, so a call inside the initializer is planned twice under two
different owner units. Measured without the gate, `class Box { p: number =
seed(); … }` inside a function is a **hard compile failure** — `ok=false`,
`selection-preparation-mismatch@resolve`, "direct-call plan … disagrees with
exact integration identity" — not a demotion. With the gate every call-bearing
initializer returns exactly to its base `body-shape-rejected`. Owning that
attribution is a later slice.

Exact initializer-shape boundary, measured one shape at a time:

| Initializer                   | Verdict                              |
| ----------------------------- | ------------------------------------ |
| literal / arithmetic / string | claims                               |
| template literal              | claims                               |
| conditional expression        | claims                               |
| array literal                 | demotes cleanly (`body-shape-rejected`) |
| enclosing-frame capture       | demotes cleanly (`class-member-unsupported`) |
| local free-function call      | rejected by the gate → base behaviour |
| `Math.floor(…)`               | rejected by the gate → base behaviour |
| `new Other()`                 | rejected by the gate → base behaviour |

The last two claim correctly when admitted, but are rejected with the rest of
the callable forms: over-rejecting costs exactly the base behaviour, while
under-rejecting costs a compile failure, so the predicate fails closed on the
whole class of shapes rather than on the one that was observed to break.

**Static methods on nested classes were measured and deliberately deferred.**
Relaxing the predicate for them produces `ok=false` with an
`unexpected-internal-throw@lower` invariant: "ABI draft
`…class-implicit-constructor…:body` would mutate sealed prepared scope
`prepared-component:…class-instance-method + …class-static-method + …`". The
implicit-constructor support binding is planned after the static component
seals. That is a sealing-order transaction, not a member-shape gate, and it is
the next slice in this family.

Coverage is `tests/issue-3522-nested-class-field.test.ts`, **24/24** on `gc`
and `standalone`: direct class/function body poison on every expected body,
exact terminal outcomes, one shared prepared component across owner + ctor +
member, Wasm validation, runtime results cross-checked against node, WAT proof
that the prepared owner carries no `externref`, boxing, `call_ref`,
`call_indirect`, `ref.test` or `__call_m_*` traffic and that the initializer
lands as a typed `struct.set`, dual-run legacy↔IR equality on four fixtures,
and a field-ORDER chain checked against the DIRECT path rather than a
hard-coded constant. Nine negative boundaries are verified rather than assumed:
the call-edge residual, a constructing initializer, a static field, heritage
(the explicit #4448/#4575 guard — the predicate still rejects heritage, so no
shadow-identity inheritance surface moves by construction), an enclosing-frame
capture, a `let`-bound class expression, name shadowing, and a positive control
proving the direct class-body emitter is still reached.

Two of those fixtures assert direct↔IR parity instead of the node value,
because the node value is not what either path produces: a field initializer
reading an enclosing `const` yields **2**, not 42, and an inner field class
shadowing an outer one yields **82**, not 42. Both were A/B'd as identical on
this branch and on unmodified `origin/main`, and identical on the direct and IR
paths — pre-existing defects this slice neither introduces nor hides.

Two negative-boundary tests in the accessor and implicit-constructor suites
pinned "an initialized instance field keeps the owner direct". That boundary
MOVED, so they now pin the call-edge residual, and the two poison-seam positive
controls that used an initialized-field class as their "unadmitted" example
switch to a static member.

Gates: focused nested/accessor/class-expression suites **54/54**; the new field
suite **24/24**; `check:ir-fallbacks --verbose` OK, no unintended, post-claim or
module-level increases (only the two unchanged deferred string-builder
candidates); `check:ir-only` **READY** — single-host **37/37 terminal units, 37
IR-emitted, 0 legacy bodies, 0 Unsupported, 0 Invariants**, standalone lane at
its baseline (22 emitted / 15 typed unsupported / 0 invariants) with every floor
green; `gen-ir-adoption --check` byte-clean after refreshing the
`ClassDeclaration` row; typecheck **508 errors on base and 508 on this branch**
(all pre-existing `@types/node` noise under symlinked `node_modules`) — no new
errors; lint and `format:check` green on every changed file.

Remaining nested class-family boundaries, in the order their surfaces grow:
STATIC members on nested classes (the sealing-order transaction above), field
initializers carrying call edges (the attribution transaction above), computed
member names, nested heritage, and then top-level class expressions with their
module-global binding ABI.

### Slice record — nested class STATIC METHODS, the sealing-order transaction (2026-08-22)

The boundary the previous slice deferred and named next. Measured on
`origin/main` `34e102dc8` before any change and again after, through the
production `compile` seam with `experimentalIR: true, trackIrOutcomes: true`.
Every row is identical on `gc` and `standalone`, and every `run=` value was
cross-checked against the same program in node.

| Fixture                                        | Before        | After         | run |
| ---------------------------------------------- | ------------- | ------------- | --- |
| nested class reached ONLY via a static, no `new` | legacy=1 ir=0 | legacy=0 ir=2 | 42  |
| two statics, no `new`                          | legacy=1 ir=0 | legacy=0 ir=3 | 42  |
| static calling a sibling static                | legacy=1 ir=0 | legacy=0 ir=3 | 42  |
| static + instance method                       | legacy=1 ir=0 | legacy=0 ir=3 | 42  |
| static + initialized field + instance method   | legacy=1 ir=0 | legacy=0 ir=4 | 42  |
| static + explicit constructor                  | legacy=1 ir=0 | legacy=0 ir=4 | 42  |
| multi-parameter static                         | legacy=1 ir=0 | legacy=0 ir=2 | 42  |
| string-returning static                        | legacy=1 ir=0 | legacy=0 ir=2 | 42  |

The gain is the whole enclosing function plus every member: before the slice the
owner read `body-shape-rejected@select` and the members were never inventoried.
The identical static-method shape on a TOP-LEVEL class already compiled once
(`legacy=0 ir=4`), so no lowering, ABI, value representation or import surface
was added — the capability was already proven.

**The recorded terminal diagnostic reproduces exactly, and only for ONE shape.**
Relaxing the member-shape gate alone gives, for a class reached ONLY through its
static side:

```
run  kind=invariant  code=unexpected-internal-throw  stage=lower
ABI draft ir-binding:v1:callable:…class-implicit-constructor…:body:…
  would mutate sealed prepared scope
  prepared-component:…class-static-method:…+…root:top-level-function:…
```

Bisected by shape one at a time, the invariant fires **iff** no `new` appears
anywhere in the transaction: `static-only, no new` · `two statics, no new` ·
`static calling a static` all throw, while the same class WITH a `new Box()`
somewhere, or beside any instance method, field or explicit constructor, is
clean. The stack names the site: `emitInstrTree → resolveClass →
ClassRegistry.resolve → initRef → bindUnitCallableSlot →
planProgramAbiUnitCallable`. `ClassRegistry.resolve` binds the source-owned
`_init` callable for **every** class shape the lowering materializes, not only
for constructed ones, and `prepareImplicitConstructorSupports` — which plans that
binding up front — scanned for `new <Identifier>` only. With no `new`, nothing
planned it, so `initRef` planned it lazily during lowering, after the static
component had sealed.

**The transaction is an ORDERING one; nothing about the seal moves.** Three
source edits:

1. `isBoundedPreparedNestedOrdinaryClass` (`src/ir/class-accessor-safety.ts`)
   rejected every static member. It now admits a static METHOD under exactly the
   member shape instance methods already carry — undecorated, identifier-named,
   body-bearing, non-abstract, non-async, non-generator, fixed-arity. A static
   method's definition evaluation is a method's: a body-bearing callable
   installed on the constructor object, with nothing running in the containing
   frame. Static FIELDS and static ACCESSORS stay rejected (below).
2. `prepareImplicitConstructorSupports` (`src/codegen/ir-plain-implicit-constructors.ts`)
   now reaches a bounded nested class through a STATIC MEMBER ACCESS on its
   identifier, exactly as it already does for `new <Identifier>`, so the support
   pair is planned in the same pre-seal planning phase as the static member.
   The reaching walk moved into `collectPreparedImplicitConstructorClasses` (the
   function budget caps the caller at 300 LOC). The static admission is
   restricted to classes that actually carry a static member, so every
   pre-existing static-free shape keeps the exact `new`-only population.
3. `isPhase1Expr` (`src/ir/select.ts`) — the correctness fix this slice forced,
   below.

**A prepared class binding is not a first-class IR value (the correctness fix).**
Admitting statics made a static-side ALIAS reachable, and it leaked. Measured
before the fix, `class Box { static k() {…} } const Alias = Box; return
Alias.k();` claimed and EMITTED `Box_k` while `run` fell back, and recorded the
post-claim BUILD error `ir/from-ast: identifier "Box" is not in scope in run` —
split ownership, which R3 exists to prevent. The equivalent instance-member
program was already withdrawn correctly, by the `constructor-resolution-unsupported`
arm on `new Alias()`; the static side has no such arm. The class-declaration and
`const C = class {…}` arms add the binding NAME to the selector scope purely so
the dedicated `new C(...)`, `C.staticMember` and `x instanceof C` arms can
consume it — those resolve the binding themselves and never reach the generic
identifier accept, so anything that DOES reach it is a bare value use. That
accept now rejects a name in `currentPreparedClassBindingNames`, withdrawing the
owner at selection so the class withdraws with it. A/B'd against unmodified
`origin/main` on seven class-binding shapes — nested `instanceof` on a
declaration, top-level `instanceof`, top-level class-as-value, nested
`new`-only declaration, nested `new`-only class expression, nested
class-expression `instanceof`, and static-beside-`new` — all byte-identical
before and after; only the two aliasing shapes move, and both move from a leak
to a clean demotion.

Exact static-member boundary, measured one shape at a time:

| Static member shape                       | Verdict                                   |
| ----------------------------------------- | ----------------------------------------- |
| static method, any arity, number/string   | claims                                    |
| static reached from a sibling static body | claims                                    |
| static beside field / method / ctor       | claims                                    |
| static FIELD                              | direct (`body-shape-rejected`)            |
| static ACCESSOR                           | direct (`body-shape-rejected`)            |
| computed static name                      | direct (`body-shape-rejected`)            |
| `async` / generator static                | direct (`body-shape-rejected`)            |
| heritage                                  | direct (the explicit #4448/#4575 guard)   |
| static capturing the enclosing frame      | direct (`class-member-unsupported`)       |
| static-ONLY class EXPRESSION              | direct (`body-shape-rejected`) — residual |
| class binding used as a VALUE             | owner AND class withdrawn together        |

A static FIELD stays out because its initializer runs at class-definition time
IN the containing frame, which is exactly the inertness the predicate asserts —
a different ordered contract. A static ACCESSOR stays out because its descriptor
is not on the ordinary descriptor-by-name-and-kind path this family resolves.

**Residual, measured not assumed: the static-ONLY class EXPRESSION.** A nested
class expression whose binding is consumed by a `new` is already admitted, and
one carrying a static BESIDE an instance member is admitted by this slice
(`const Box = class { static base() {…} get() { return Box.base() + 2; } }`
compiles once). What stays out is the static-ONLY expression: its `const`
binding is proven safe only for CONSTRUCTION uses
(`boundedClassExpressionBindingHasOnlyStaticConstructionUses`), which a static
member access is not, so the binding never reaches the projected local-class set
and the owner rejects at `body-shape-rejected` — its base behaviour, a clean
demotion, not a failure. Widening that binding proof is a separate transaction
from the sealing order and is left to the class-expression boundary.

Coverage is `tests/issue-3522-nested-class-static.test.ts`, **33/33** on `gc`
and `standalone`: direct class/function body poison on every expected body,
exact terminal outcomes, one shared prepared component across owner + statics
whose id is asserted to NAME the `class-static-method` scope (the scope whose
seal the draft used to arrive after), Wasm validation, runtime results
cross-checked against node, dual-run legacy↔IR equality on six fixtures, and a
static-call evaluation-ORDER chain checked against the DIRECT path rather than a
hard-coded constant. The WAT proof uses a parameterised fixture so the static
call cannot constant-fold: the prepared owner, the static and the instance
method carry no `externref`, boxing, `call_ref`, `call_indirect`, `ref.test` or
`__call_m_*` traffic; `run` reaches the static as a direct `return_call`; the
STATIC callable declares no receiver slot while the instance method beside it
declares `(param (ref null …))`; and `run` contains no `struct.new` — a class
reached only through its static side allocates nothing, so the ordering fix
plans the `_init` binding without forcing a construction. Eleven negative
boundaries are verified rather than assumed (the table above plus a
name-shadowing direct↔IR parity check and a positive control proving the direct
class-body emitter is still reached).

One pin in the implicit-constructor suite moved: "keeps a nested class with a
static member direct" pinned a static METHOD, which this slice admits. It now
pins the static ACCESSOR, the boundary that remains.

**A pre-existing defect found while A/B-ing, neither introduced nor hidden
here:** `const Box = class { get() { return 42; } }; const b = new Box(); return
b instanceof Box ? b.get() : 0;` returns **0**, not 42 — identically on this
branch and on unmodified `origin/main`, on the direct path. Nested
class-expression `instanceof` evaluates false. Not this slice's territory;
recorded so it is not rediscovered as a regression.

Gates: focused class-family suites (nested implicit-constructor, accessor,
field, class-expression ownership, nested-class ownership, static class-method)
plus the new suite **114/114**; `check:ir-fallbacks --verbose` OK — no
unintended, post-claim or module-level increases (only the two unchanged
deferred string-builder candidates); `check:ir-only` **READY** on both lanes —
single-host and standalone each **38/38 terminal units, 38 IR-emitted, 0 legacy
bodies, 0 unsupported, 0 invariants**, byte-identical to the same run on
unmodified base; `check:ir-only --policy=hybrid` **READY**;
`gen:ir-adoption --check` byte-clean with no row refresh needed; typecheck
**543 errors on base and 543 on this branch** (all pre-existing `@types/node`
noise under symlinked `node_modules`) — no new errors; lint and `format:check`
green on every changed file.

Budget grants for this change-set are in this file's frontmatter, not in any
`scripts/*-baseline.json`: `src/ir/select.ts` was already granted under
`loc-budget-allow`, and `src/ir/select.ts::isPhase1Expr` is added under
`func-budget-allow`. Both report the same **+16 LOC** for the value-use guard
(`10040 → 10056`; `isPhase1Expr` `1072 → 1088`). The reaching-set
extraction kept `prepareImplicitConstructorSupports` under its own 300-LOC cap
without a grant.

Remaining nested class-family boundaries, in the order their surfaces grow:
field initializers carrying call edges (the attribution transaction recorded in
the previous slice), static-ONLY class expressions (the binding-proof residual
above), computed member names, static fields with their class-definition-time
ordered contract, nested heritage, and then top-level class expressions with
their module-global binding ABI.

### Implementation plan — nested instance-field direct calls (2026-08-26)

This plan owns the first remaining boundary named above: an initialized
instance field of a bounded nested class calling one exact same-source
top-level function. It does not admit method calls, constructors, tagged
templates, imported targets, arbitrary dynamic calls, or static-field
definition evaluation.

The current failure has two independent causes, and neither is a lowering
deficiency:

1. **The explicit-constructor inventory owner is wrong.** A bounded nested
   explicit constructor is already promoted to a terminal class-member unit,
   but the field support records still inherit the containing function as their
   terminal owner. The corresponding implicit initialized constructor already
   self-owns its fields correctly. For both forms the field's lexical owner is
   the class; its execution owner must be the exact constructor terminal, while
   that constructor retains the containing function in
   **containingTerminalOwnerId**.
2. **The direct-call collector is ownership-blind.**
   **collectIrDirectCallLoweringPlans** recursively walks whichever root it is
   given and assigns every nested call to the supplied owner. The overlay can
   therefore record the same field call once as an outer-function call and
   again as a constructor call. Constructor integration rescans the exact
   initializer and correctly throws **selection-preparation-mismatch** rather
   than accept the conflicting owners.

The exact seams already exist. **requireIrPlanningOwnerUnitId** resolves an AST
site through its nearest scanner-indexed declaration to the authoritative R0
terminal owner. **collectLocalCallEdgesByIdentity** already treats property
initializers as ownership boundaries and already drives the combined R2/R3
free-function plus class-member fixed point. Once inventory ownership is
correct, it naturally records constructor → callee rather than outer function
→ callee.

Do not generalize **IrIdentitySelection.localCallees** in this work. That map is
deliberately the function-only legacy projection, and its validator requires
both endpoints to be function units. The later identity call-edge collector is
the authoritative mixed-owner graph. Its conservative function-only
over-approximation across a nested class is harmless because nested ordinary
class atomicity already withdraws the enclosing owner with the class.

Land the plan amendment and the following four implementation checkpoints as
separate ready PRs. Each implementation checkpoint is rebased from live
**main** only after its predecessor merges. No checkpoint may be stacked
behind an unpublished predecessor.

#### F1. Correct existing explicit-constructor field ownership

Limit production changes to:

- **src/ir/identity.ts**.

Focused test ownership:

- **tests/issue-3520-ir-unit-identity.test.ts**;
- **tests/issue-3520-planning-owner.test.ts**; and
- only the exact identity-edge assertion needed in
  **tests/issue-3520-ir-first-identity.test.ts**.

For an already-bounded nested class, choose **explicitConstructor.id** as the
instance-field support terminal owner when that exact record is terminal.
Otherwise retain the current inherited owner. This is an identity correction,
not an admission change:

- the constructor remains terminal and self-owned;
- the constructor's **containingTerminalOwnerId** remains the outer executable;
- the field's **lexicalOwnerId** remains the exact class ID;
- the field's **terminalOwnerId** becomes that exact constructor ID; and
- an unsupported nested constructor remains support-owned by the outer
  executable exactly as before.

Prove explicit and implicit initialized constructors side by side, with and
without an enclosing function, and mutate one owner/source/class/declaration
join at a time. The runtime route, selector population, emitted bytes, and
current call-bearing-field rejection must remain unchanged. No selector,
direct-call, Program ABI, component, or lowering file belongs in F1.

#### F2. Make source direct-call collection exact-owner-aware

Limit production changes to:

- **src/ir/ast-lowering-plans.ts**;
- **src/codegen/ir-overlay-identity.ts**; and
- **src/ir/integration.ts**;
- **src/codegen/index.ts**, to thread the already-built identity resolver to
  every identity-aware projection/reconciliation call; and
- **src/codegen/ir-prepared-free-functions.ts**, to merge the full-selection
  and remaining-selection authenticated plan maps only through exact equality;
  and
- **src/ir/imported-functions.ts** only if the existing resolver interface
  needs a narrowly shared certification method rather than a new resolver.

Focused test ownership:

- **tests/issue-3520-lowering-plan-identity.test.ts**; and
- **tests/issue-3522-ir-nested-class-ownership.test.ts**.

Add a distinctly named identity-aware collector rather than an optional
best-effort mode. For each candidate call, require:

- the exact call AST belongs to the supplied source;
- **requireIrPlanningOwnerUnitId(identityContext, call)** equals the requested
  owner;
- that owner is an exact active terminal record;
- an **IrIdentityImportedFunctionResolver**, or an equivalently exact AST-keyed
  certification retained from it, resolves the call's identifier through
  **resolveTopLevelFunctionValueTarget(call.expression)**;
- the resolved declaration, source, source-qualified unit ID, binding, and
  compatibility name all equal the retained callable target; and
- the retained signature is equal by the canonical closure-signature
  comparator.

The checker-backed/AST-keyed result is the authority. The current
**targetsByLegacyName** map may remain only as a compatibility projection after
that exact target has been certified; it must never choose or authenticate the
target. A lexical shadow, imported binding, reassigned declaration, or
same-spelled declaration from another source must fail even if the legacy map
contains an otherwise compatible row. Thread the one resolver already created
for the source through overlay projection and integration reconciliation; do
not reconstruct checker authority from a name, span, or owner context.

Use that collector in both overlay projection and integration reconciliation.
An outer traversal must skip a call whose exact terminal owner is a nested
constructor; the constructor traversal retains it. A nested support callable
whose inventory terminal owner legitimately remains the containing function
continues to belong to that function.

Do not rely on **Map.set** to resolve a collision. A second producer for one
AST call must either revalidate and reuse the one authenticated retained row or
fail before replacing it; a different owner, binding, name, signature, source,
or AST object always fails closed. Preserve the context-free collector for
isolated stdlib-selfhost and linear callers until those routes supply the same
authoritative identity context. Their behavior must remain byte-identical.

F2 remains behavior-neutral because the field-call gate is still closed. Use
an already-admitted nested method calling a top-level function as the positive
class-owner control. Add outer-root, nested-function, implicit-constructor,
explicit-constructor, stale AST, copied SourceFile, wrong owner, same-spelled
foreign target, binding, name, and signature mutations. **from-ast.ts** needs
no change: it already consumes an exact AST-site plan and verifies its owner
before emitting the symbolic target.

The implicit-constructor control in F2 is deliberately negative: with the
field-call gate closed, any natural call owned by an implicit constructor would
have to occur in an instance-field initializer, and that exact shape remains
unbounded until F3/F4. Its support/nonterminal owner must therefore reject the
identity-aware collector. Do not fabricate a terminal implicit constructor or
admit a call-bearing field to manufacture a positive F2 row. F4 owns the first
natural positive implicit-constructor field-call control.

#### F3. Retain dormant source-qualified field-call evidence

Build the proof before selection and keep production behavior closed. Prefer a
narrow new module:

- **src/ir/class-field-call-planning.ts**.

Expected integration ownership:

- **src/ir/class-accessor-safety.ts**, for a syntax-only inventory-candidate
  predicate that is not a selector admission predicate;
- **src/ir/identity.ts**, to mint the exact constructor and field-support
  identities for that candidate while leaving it unclaimed;
- **src/ir/select-identity.ts**, only for the immutable proof/candidate
  input/output and exact typed fallback normalization described below;
- **src/codegen/ir-overlay-identity.ts**;
- **src/codegen/index.ts**; and
- **src/ir/imported-functions.ts** only if the existing exact resolver needs a
  narrowly shared method.

Focused test ownership:

- new
  **tests/issue-3522-nested-class-field-call-planning.test.ts**; and
- resolver tests only if the resolver API changes.

F3 first splits identity candidacy from the current lowering/admission
predicate. Add one explicitly named syntax-only candidate for the narrow bare
field-call shape. Only the inventory scanner consumes it: a call-bearing nested
class receives the same constructor terminal, containing-owner edge,
field-support unit, and constructor-owned support edge that an
already-bounded initialized class receives. The existing
**isBoundedPreparedNestedOrdinaryClass** remains unchanged and remains the
selector/preparation gate, so this new identity population is typed but
unclaimed. No other predicate consumer may switch to the candidate in F3.

Retain an immutable, proof-independent inventory-candidate marker for that
exact class, constructor, source, and inventory snapshot. It exists for every
syntax candidate even when proof collection is disabled, missing, or invalid.
**select-identity.ts** may consume this marker only to normalize the
still-unclaimed implicit or explicit constructor and body-member terminals to the promised typed
**class-member-unsupported@select** fallback/outcome. It must not turn the
candidate into a claim or preparation input. The instance-field initializer
remains a constructor-owned support unit and therefore has no independent
terminal outcome.

This ordering is load-bearing. Building the exact field-call proof before the
constructor and field support identities exist would force it to invent an ID
or borrow the outer owner; waiting until F4 to mint those identities would make
selection depend circularly on evidence that cannot yet be constructed.

The proof is keyed by the exact initializer **CallExpression** and retains:

- exact source file and source ID;
- exact class, field, constructor, call, and callee declaration objects;
- class ID, field-support unit ID, constructor terminal ID, containing terminal
  ID, and callee unit ID;
- the exact bare-identifier call edge;
- the target's exact source-unit callable reference and stable signature; and
- a frozen argument/arity projection for the bounded family.

Reuse
**IrIdentityImportedFunctionResolver.resolveTopLevelFunctionValueTarget**.
That resolver already proves a unique, non-reassigned, same-file top-level
function and returns its exact source-qualified unit ID. Do not create a
parallel name resolver, use the checker-free call graph as admission authority,
or fall back to a suffix, span, display name, or legacy map. The checker-free
graph remains component-closure evidence only.

The forward and reverse joins are mandatory: AST call → field support →
constructor terminal → class/source, and target identifier → exact declaration
→ exact callee unit/source. A copied AST, rebuilt inventory, wrong source,
wrong field or constructor, ambiguous/reassigned/overloaded target, stale
signature, optional/spread/generic call, or changed argument population
invalidates the proof.

Retain the proof as a separate optional immutable sidecar keyed back to the
proof-independent inventory-candidate marker; never make the marker's
existence depend on proof success. Retain both on the identity/overlay plan as
source-qualified evidence. The newly inventoried constructor/member terminal
rows are deliberate: while admission is inactive they must each reconcile to the exact typed
**class-member-unsupported@select** disposition/outcome required by the
existing terminal-outcome contract. Do not silently omit those terminals or
leave them without an outcome. Field-initializer support rows instead reconcile
through their constructor terminal exactly as the inventory contract requires.

F3 must not change claims, prepared candidates, runtime output, or emitted
bytes. Its new typed inventory denominator and matching terminal/fallback rows
are expected and must be pinned explicitly. Proof-enabled versus proof-disabled
A/B controls compare after constructing the same candidate inventory and must
have identical claims, terminal outcomes, preparation, runtime, and bytes;
only the immutable dormant proof sidecar may differ. A comparison against the
pre-F3 implementation may therefore differ only by those pinned candidate
inventory and typed fallback/outcome rows, never by an admitted body.

F3 shares the identity-selection and direct-call sidecar seam with #3521.
Rebase it onto the exact landed #3521 L1/L3 API and use that API's ownership and
copy-on-write rules. Do not land a competing resolver or mutable sidecar.

##### F3a disjoint dormant-evidence checkpoint (2026-08-28, non-authoritative)

The disjoint F3 core is intentionally separable from the active
`src/codegen/index.ts` merge surface. It establishes the following contracts
without activating F4:

- `isNestedOrdinaryClassFieldCallInventoryCandidate` is a syntax-only
  inventory predicate. The existing
  `isBoundedPreparedNestedOrdinaryClass` selector/preparation gate remains
  unchanged.
- The inventory promotes only that exact direct-nested candidate's constructor
  and body members to terminal identities, keeps every field initializer as a
  constructor-owned support row, and retains an immutable marker tied to the
  exact inventory, source, class, constructor, containing terminal, fields,
  calls, and terminal-member rows.
- `class-field-call-planning.ts` reuses the exact identity imported-function
  resolver's same-source top-level value path. It retains a frozen
  source-qualified `IrFuncRef`, explicit stable callable signature, and exact
  argument population only after every forward/reverse AST and inventory join
  revalidates.
- Selection consumes the proof-independent marker only to force every newly
  inventoried constructor/member terminal to
  `class-member-unsupported@select`; it does not consume the optional proof for
  admission. Identity and overlay plans retain the marker and optional proof
  sidecar as dormant evidence.

This checkpoint is **not F3 acceptance** while the final production seam is
unwired. The overlap audit originally found #5154 at `be5ec432…`, #5148 at
`fd7b280c…`, and #5097 at `f10283be…` touching `src/codegen/index.ts`. #5154 is
now present in the refreshed `a2191bb09520…` base; the disjoint branch still
deliberately leaves that file untouched while #5148/#5097 remain adjacent.
After those heads settle, the remaining narrow follow-up is:

1. construct the already-shared exact resolver once before identity selection;
2. call `planIrNestedClassFieldCalls` over the exact planning context and pass
   its sidecar through `IrIdentitySelectionOptions`;
3. retain that same sidecar on the outer overlay plan without rebuilding it;
4. run the proof-enabled/proof-disabled full compiler A/B matrix and pin exact
   inventory/outcome deltas, unchanged claims/preparation/runtime/bytes, and
   proof-only sidecar variance.

Direct planner/identity tests are necessary evidence for this checkpoint but
cannot substitute for that final compile A/B. Until the follow-up lands, the
production path intentionally behaves as proof-disabled: the typed candidate
inventory and exact unsupported terminal outcomes exist, but no field-call
body is admitted or prepared.

Checkpoint evidence on the refreshed `a2191bb09520…` base. The only
intervening changes since the measured `9f5c421b9849…` baseline were the
unrelated #5157/#5158 issue plans; they did not touch this source or test
surface:

- TS 7 and TS 5 no-emit checks pass.
- The focused dormant-planner matrix passes **16/16** and the four directly
  affected identity/ownership files pass **55/55**.
- The complete 20-file #3522 matrix on code-identical `9f5c421b9849…` reports
  **300 pass / 17 fail**. A clean detached worktree at that same base reproduces
  those exact 17 failures in the same four files (two cross-owner expectations,
  eleven stale GC import-surface expectations, and four nested-static poison
  expectations), so they are current-main baseline debt rather than an F3a
  delta.
- Prettier, IR layering, IR fallback, IR-only readiness, IR adoption,
  codegen-fallback, oracle, coercion-site, optimization-retirement,
  dead-export, LOC, and function-budget gates pass. The LOC gate measures
  **+669 src LOC** with no unallowed growth; the existing issue-local function
  grant accounts for `planIrCompilationByIdentity` growing **481 → 542**.

#### F4. Activate only the exact prepared field-call family

Primary production ownership:

- **src/ir/class-accessor-safety.ts**;
- **src/ir/identity.ts**;
- **src/ir/select-identity.ts**;
- **src/codegen/index.ts**;
- **src/codegen/ir-overlay-identity.ts**;
- **src/codegen/ir-class-shapes.ts**;
- **src/codegen/ir-prepared-free-functions.ts**;
- **src/codegen/class-bodies.ts**;
- **src/codegen/ir-prepared-nested-executable-syntax.ts**;
- **src/ir/module-bindings.ts**; and
- **src/ir/from-ast.ts**, for the exact admitted immutable class-expression
  binding at the final lowering boundary.

Audit, but do not edit without a demonstrated shared-API need:

- **src/codegen/ir-plain-implicit-constructors.ts**;
- **src/ir/prepared-component-dependencies.ts**.

Separate inventory candidacy from selector admission. A class may receive the
exact constructor/field identities required to validate an F3 proof in F3, but
it becomes claimable only here and only when every call-bearing field carries a
current exact proof. Replace only the selector/preparation uses of the strict
predicate with a proof-consuming admission decision; keep syntax-only
inventory candidacy distinct.
Never make arbitrary calls admissible by deleting **CallExpression** from
**boundedPreparedInstanceFieldInitializer**.

F3 may retain dormant proof and inventory candidacy, but it may not manufacture
admission. In F4, **codegen/index.ts** validates the complete proof and computes
one immutable, proof-derived admitted-class marker before local class-expression
resolution and identity selection. The overlay plan carries that marker without
recomputation into **ir-class-shapes**, **module-bindings**, and the selector.
For `const C = class { ... }`, project one exact marker-aware binding
identity/name into the class-shape sidecar, carry that same identity through
local-class resolution, and require it again at the **from-ast** lowering site.
No consumer may call
**boundedPreparedNestedOrdinaryClassBindingName** as an independent admission
decision for that candidate. Thread that same marker through selection,
**ir-prepared-free-functions**, **class-bodies**,
**ir-prepared-nested-executable-syntax**, and **module-bindings**. Those
consumers must not independently re-run, approximate, or widen the syntax
predicate: they either consume the exact admitted marker for the same class,
source, constructor, and proof snapshot or fail closed. The
plain-implicit-constructor and final dependency routes remain audit controls
unless a test demonstrates that this immutable marker must cross one of their
existing boundaries. The final combined prepared fixed point must
revalidate every admitted marker against surviving constructor/callee units and
withdraw the whole class if any dependency or proof row disappeared; the
preselection marker is evidence, never a bypass around final reconciliation.

The first positive family is deliberately narrow:

- one nested ordinary class declaration or immutable class expression;
- no heritage, static field, computed field name, decorator, nested executable,
  **super**, construction, member call, tagged template, import, or
  cross-source target;
- a fixed-arity bare call to one unique non-reassigned same-source top-level
  function;
- no optional, spread, generic, or dynamic argument edge;
- exact stable parameter/return types already supported by the prepared
  constructor field lowerer; and
- caller, constructor, callee, and enclosing owner all surviving the existing
  combined R2/R3 candidate fixed point.

The existing pipeline remains authoritative after admission:
**collectIrClassInstanceInitializers** preserves source order; constructor
integration binds each exact initializer to the constructor owner; direct calls
lower through the retained **IrFuncRef**; final IR calls become Program ABI unit
references; and post-pass component derivation closes over the final symbolic
edge. Do not add a new lowering opcode, eager legacy body, provider
publication, sealing exemption, or compile-twice retry.

Positive runtime/Wasm coverage runs on both **gc** and **standalone**:

- implicit nested declaration with **p = seed(40)**;
- explicit constructor proving field initialization precedes constructor-body
  reads;
- immutable nested class expression;
- two source-ordered call-bearing fields;
- inlining disabled, with one exact constructor call target visible in WAT;
- inlining enabled, where optimization may remove the call but semantic and
  final component evidence remains valid;
- the already-admitted nested-method call from F2; and
- an unchanged top-level initialized-field call.

Poison every expected direct body. Require exact outcomes for the outer owner,
constructor, members, and callee; one prepared component before a legitimate
optimizer removes an edge; zero legacy bodies for the positive component; no
post-claim errors; valid Wasm; node/direct/IR runtime equality; and exact
evaluation order.

Negative source controls remain direct without an invariant:

- unpreparable, unknown, imported, cross-source, duplicate, overloaded,
  reassigned, or same-spelled foreign target;
- lexical shadowing or enclosing-frame capture;
- optional, generic, or spread call;
- member call such as **Math.floor(...)**;
- **new**, tagged template, nested executable, or **super**;
- static field, heritage, dynamic computed field, or mutable class-expression
  binding; and
- a callee removed by the final prepared fixed point.

One-fact fail-closed mutations cover:

- field owner changed from constructor to outer;
- field/class/source/constructor ID or AST object replaced;
- constructor no longer self-owned or its containing owner changed;
- call plan owner changed, missing, duplicated, or attached to a copied AST;
- same-spelled target UnitId, binding, compatibility name, or signature changed;
- source file/source ID mismatch;
- selected callee removed from the prepared denominator;
- final symbolic call missing its Program ABI unit binding; and
- component evidence attributing the call to the outer function.

The unpreparable-callee control must prove successful direct execution, exact
direct binary/WAT parity, a typed Unsupported outcome, and poison evidence that
the direct constructor emitter remained live. Successful execution alone is
not acceptance evidence.

#### Dependencies, conflicts, and landing gates

This issue formally depends on #3521. The docs-only plan amendment is unblocked
and may land now; it authorizes no runtime replay and no R3 completion claim.
F1 is technically disjoint and behavior-neutral. F2 and F3 share the
source-qualified direct-call map with #3521's active L1/L3 work, so they wait
for that API to land or rebase onto it exactly. F4 remains HOLD until the shared
#3521 evidence API has one owner and F1–F3 are merged.

#4260's prepared provider transaction is disjoint provided this work does not
edit Program ABI session/provider/import/type planning or component sealing.
Do not solve field calls by moving provider publication, weakening atomic
sealing, or retaining dead imports.

For every implementation checkpoint run its focused suites, the full existing
#3522 class-family matrix, TypeScript 7 and 5, Prettier/Biome, IR
layering/dialect/fallback/IR-only/adoption gates, cross-backend differential
coverage, oracle/coercion/optimization/dead-export ratchets, and LOC/function
budgets. Measure source/function growth before adding any exact issue-scoped
allowance; never raise a global baseline speculatively. Run
**pnpm run check:loc-budget** again immediately before every signed commit.
Never skip pre-commit or pre-push hooks.

Every heavy command and every commit/push boundary requires a fresh finite,
non-negative one-minute load strictly below **logical cores - 2**. Each signed
checkpoint receives independent read-only review before push and is shepherded
through actual merge before its successor is published.

### 2026-08-27 F2 implementation checkpoint — exact-owner direct-call plans

F2 is implemented as the behavior-neutral authority split specified above.
`collectIrDirectCallLoweringPlansByIdentity` is a distinct collector; the
context-free collector used by resolver-less linear and stdlib-selfhost routes
retains its prior contract. The identity-aware path requires the exact source
and planning owner for each AST call, active self-owned owner and target
terminals, and the one source resolver's
`resolveTopLevelFunctionValueTarget` certification. Declaration object,
source-qualified unit, callable binding, compatibility name, and canonical
closure signature are revalidated before one retained plan can be projected or
reconciled. Copied roots/sites, lexical ancestry drift, same-spelled foreign
targets, stale owners, bindings, names, signatures, or source identities fail
closed.

The one resolver is threaded through single- and multi-source overlay planning
and integration reconciliation. Source-unit targets remain disjoint from the
non-unit runtime/intrinsic compatibility projection. A duplicate producer may
only reuse an identical authenticated row; `Map.set` never resolves an owner
collision, including when full-selection and remaining-selection plan maps are
combined. The existing field-call selector gate stays closed, so this slice
does not admit a class field, change a claim/outcome, or alter emitted behavior.

Focused evidence covers outer-root, nested-function, implicit/explicit
constructor, admitted nested-method, copied AST/source, ancestry, wrong-owner,
foreign-target, binding/name/signature, and collision controls. The #3522
GC/standalone matrix is 7/7 and the new #3520 collector/collision/mutation
controls are 4/4. TypeScript 7 and 5, formatting, IR layering, fallback
controls, and the function ratchet pass. The full adjacent #3520 suite is
13/13. Its host-void-callback fixture now supplies the exact admitted
`HTMLElement_addEventListener` operation certificate, so missing/stale owner
mutations reach the intended callback-plan invariant instead of stopping at the
earlier generic capability guard. With only that test-fixture correction, exact
parent `5bdc209f0de611808a701d9b08a0b971d689f12f` passes the original denominator
9/9; F2 passes all 13. Against that same parent, F2 is
byte-identical within every measured target/option: GC direct is 974 bytes,
SHA-256 `b9358ef967232d9248c5e14b660fba012397e344f45d108bc926329516300d77`;
GC experimental is 981 bytes,
`b18876938bb429a377c5abdb3a476cf3a6c554fd8ca3d9dec64c68861d70259e`;
standalone direct is 49,113 bytes,
`e1a48a77e3c902f5097cc4329c7787f70dc99af68621d2ac418da3c9e34229ee`;
and standalone experimental is 49,120 bytes,
`33b6777e092efee30c6f20e2266aba9125ed0efcd75de15831a7153dd0d02041`.
The pre-existing 7-byte direct-versus-experimental difference is unchanged and
is not attributed to F2.

Production growth is confined to the five files authorized by F2: +152 in
`src/ir/ast-lowering-plans.ts`, +29 in
`src/codegen/ir-overlay-identity.ts`, +25 in
`src/codegen/ir-prepared-free-functions.ts`, +30 in
`src/codegen/index.ts`, and +37 in `src/ir/integration.ts`. The existing
issue-scoped LOC allowances for `index.ts` and `integration.ts` cover those
measured changes when this plan is included in the checkpoint; no budget
baseline changes. F2 remains `in-progress` work under #3522. F3 dormant
field-call evidence and F4 bounded admission remain separate post-merge
checkpoints and inherit the same independent-review, strict-load,
signed-commit, and unskipped-hook gates.

The post-push kind-neutrality gate found one evidence location made stale by
the added `integration.ts` lines. The `forof.string` row keeps its existing
`js` verdict, `dialect` placement, rationale, declaration, and two-entry
evidence set; only the integration evidence location moves from line 5109 to
line 5146. The relocked
baseline SHA-256 is
`42686323c13fcb8539e82b179efd89a4d2feba10edefc7d4772ca65130a91a42`.
`check:ir-kind-neutrality` again reports 85 kinds: 55 neutral, 27 JS-dialect,
and 3 unresolved, with 58 core placements and 27 dialect placements. No row,
verdict, placement, or phase-two move was added, removed, or widened.

### 2026-08-28 F4 implementation checkpoint — the exact prepared field-call family

F4 activates the narrow family F3 prepared evidence for, and nothing wider.
Measured baseline on `origin/main` `81e54a98e`, through the production
`compile` seam with `experimentalIR: true, trackIrOutcomes: true`, for
`class Box { p: number = seed(40); get(): number { return this.p; } }` inside
`run`: `seed=emitted(ir)`, and `run`, `Box_new@`, `Box_get@` all
`unsupported(legacy)` on both **gc** and **standalone**. On this branch all
four are `emitted(ir)` with `legacyBodyEmitted: false`, on both lanes, with the
direct class and function emitters poisoned.

**Candidacy stays separate from admission.**
`isBoundedPreparedNestedOrdinaryClass` is unchanged and still refuses a
call-bearing field; `boundedPreparedInstanceFieldInitializer` still rejects
`CallExpression`. It is now expressed as
`isBoundedPreparedNestedOrdinaryClass(d) ? nestedOrdinaryClassLexicalBindingName(d) : undefined`,
so the syntax-only lexical name is shared by inventory candidacy and admission
without either deriving from the other.

**One marker, computed once, threaded never recomputed.** `planIrOverlay` in
`src/codegen/index.ts` now constructs the ONE exact resolver at the top of the
function (it previously built it at the plan boundary), calls
`planIrNestedClassFieldCalls` over it, and derives one immutable
`IrNestedClassFieldCallAdmission` via
`computeIrNestedClassFieldCallAdmission` — all before `buildIrClassShapes`
(`selection-candidate`), before `makeIrLocalClassExpressionResolver`, and
before identity selection. That same object is then passed to the
selection-candidate and lowering class-shape builds, local class-expression
resolution, `planIrOverlayByIdentity`, and the class-body routing; it is
carried on `IrIdentitySelection` and `IrOverlayIdentityPlan` and read from
there by `ir-prepared-free-functions`, `class-bodies` and
`ir-prepared-nested-executable-syntax`. No consumer re-runs a syntax predicate:
each either finds the exact class in the marker or falls back to the unchanged
strict predicate. `src/ir/from-ast.ts` requires the identity again at the
lowering boundary by exact `classId` — the shape published in the class-shape
sidecar under the binding name must be the shape of exactly that class
expression — which is strictly stronger than the previous name-plus-presence
check and closes the outer-class shadowing hole.

The admission is minted only when the sidecar belongs to this exact inventory,
EVERY call-bearing field carries a currently valid proof whose class, field,
constructor, containing owner, source and `IrFuncRef` all rejoin the candidate,
and the class resolves one lexical binding name. The selector then revalidates
every admitted row against the live inventory — including that each field's
callee is an exact active same-source top-level function terminal whose
declaration name equals the retained compatibility name — and raises a typed
planning invariant otherwise. The final combined R2/R3 prepared fixed point in
`ir-prepared-free-functions.ts` treats each admitted class as one atom:
constructor, every promoted body member, the containing terminal owner and
every proved callee survive together or the whole class withdraws.

**The first family excludes nested executables, and that exclusion is
measured, not assumed.** On `origin/main` a CALL-FREE bounded nested class
whose method contains `const f = (): number => this.p` is already a hard
compile failure (`ir/from-ast: 'this' reference outside an instance method
body`, owner outcome `invariant`). Admitting the field-call variant of that
shape produced the identical failure, so
`nestedOrdinaryClassBodyHasNestedExecutable` keeps it out; the control is
pinned in the negative matrix and now matches `origin/main` exactly.

Positive coverage on both **gc** and **standalone**, with the direct class and
function emitters poisoned: implicit nested declaration, explicit constructor
proving field initialization precedes constructor-body reads (`40100`, where
every wrong ordering yields `0` or `NaN`), immutable nested class expression,
two source-ordered call-bearing fields, the already-admitted F2 nested-method
call, and the unchanged top-level initialized-field call. Component evidence
attributes the call to the CLASS: `run`, `Box_new@` and `Box_get@` share one
`prepared-component:` id naming both the `class-implicit-constructor` and the
`class-instance-method` terminals, while the callee keeps its own single-unit
component.

With inlining OFF the emitted call edge is observable exactly once, in the
constructor `_init` and nowhere else, with no `call_ref` / `call_indirect` /
`__call_m_`. That assertion needed a non-foldable callee: with
`seed(v) => v + 2` the whole initializer folds to `f64.const 42` even at
`JS2WASM_IR_INLINE=0`, and emitted calls carry the numeric function index, not
`call $seed` — a `call \$seed` regex matches nothing and the assertion would
have passed vacuously. With inlining ON the optimizer may remove the edge;
semantics, validity and the component evidence still hold.

Negative source controls, each measured identical on `origin/main` and on this
branch: member call, construction, tagged template, optional call, generic
call, spread call, lexical shadowing, enclosing-frame capture, overloaded
target, static field, heritage, dynamic computed field name, mutable
class-expression binding, nested executable in a member, a callee removed by
the final prepared fixed point, and a same-spelled cross-source target. Three
of these carry PRE-EXISTING direct-path divergences from node unrelated to F4
(spread evaluates to `NaN`/`0`, lexical shadowing resolves the outer `seed`,
enclosing-frame capture yields `0`), so those rows are anchored to the direct
compiler rather than to a node constant; the optional-call program is a
pre-existing hard codegen failure on `origin/main` and is therefore proved at
the marker level instead of the runtime level.

The unpreparable-callee control proves all four required facts: successful
direct execution, exact whole-WAT and whole-binary parity between
`experimentalIR: false` and `experimentalIR: true`, typed `unsupported`
outcomes for the owner and both class members, and a firing
`JS2WASM_TEST_POISON_DIRECT_CLASS_BODY` proving the direct constructor emitter
stayed live.

Evidence:

- New focused suites pass **59/59**: `issue-3522-nested-class-field-call-admission`
  38/38 (both lanes) and `issue-3522-nested-class-field-call-marker` 21/21.
- The marker suite covers the one-fact fail-closed mutations: forged
  (non-planner) marker, wrong inventory, replaced class/constructor/containing/
  source id, replaced class declaration object, replaced inventory candidate,
  mismatched `SourceFile`, replaced field declaration / initializer call /
  field-support unit id / callee unit id / callee compatibility name,
  duplicated admitted row, missing field row, and construction without planner
  authority.
- The #3522 class-family matrix, run in batches on a 16 GB container: **19 of
  20 files** run; `issue-3522-ir-object-method-call-ownership` OOMs the vitest
  fork on `origin/main` and on this branch alike (also true of
  `issue-3521-prepared-free-function-routing`), so it is an environment limit,
  not a delta. Across the 19: **7 failures, all reproduced identically on
  `origin/main` `81e54a98e`** — four nested-static, one accessor
  optimized-binary bound, one cross-owner unsupported-console parity, one
  captured object-method gc. **F4 introduces no new failure.**
- Four pre-F4 boundary pins were retargeted, because they pinned exactly the
  gate F4 opens: the three "field initializer CALLS a local function stays
  direct" controls now use a MEMBER call (which no proof can reach), and
  `issue-3522-ir-nested-class-ownership`'s "keeps the call-bearing nested field
  family closed" became "prepares the call-bearing nested field family once".
  The retargeted controls were verified to stay direct.
- Adjacent suites pass: `issue-3520-ir-unit-identity`,
  `issue-3520-planning-owner`, `issue-3520-lowering-plan-identity`,
  `issue-3520-ir-first-identity` and `issue-3521-prepared-component-dependencies`
  **96/96**; `class-expressions` and `nested-class-declarations` 4/4.
- TypeScript 7 and TypeScript 5 no-emit, Prettier, Biome lint, IR layering (86
  import lines, baseline 86), IR dialect, IR fallback, IR-only readiness
  (verdict READY), IR adoption, codegen-fallback, oracle, coercion-site,
  optimization-retirement, dead-export, LOC and function budgets all pass,
  including the CI-base simulation (`LOC_GATE_BASE=origin/main`).
- `check:ir-kind-neutrality` needed one evidence relocation caused by the +24
  lines in `from-ast.ts`: `vec.new_fixed` moves from `from-ast.ts:4502` to
  `:4526` and `vec.set`'s second evidence entry from `:380` to `:383`. No row,
  verdict, placement, rationale or phase-two move changed; the diff is two
  lines. The relocked baseline SHA-256 is
  `64c8e68d5c56620872363b187c381255a1c2e989a5d09a217fd2e7c60df1bc1f`, and the
  gate again reports 85 kinds: 55 neutral, 27 JS-dialect, 3 unresolved, 58 core
  placements, 27 dialect placements.

Production growth against `81e54a98e`, confined to the F4 ownership list:
`src/ir/select-identity.ts` +156, `src/ir/identity.ts` +120,
`src/ir/class-accessor-safety.ts` +59, `src/codegen/index.ts` +36,
`src/codegen/ir-prepared-free-functions.ts` +25, `src/ir/from-ast.ts` +24,
`src/ir/module-bindings.ts` +14, `src/codegen/ir-overlay-identity.ts` +11,
`src/codegen/class-bodies.ts` +7, `src/codegen/ir-class-shapes.ts` +7,
`src/codegen/ir-prepared-nested-executable-syntax.ts` +4 — net **+463 src
LOC**. `src/codegen/ir-plain-implicit-constructors.ts` and
`src/ir/prepared-component-dependencies.ts` remained audit-only: no test
demonstrated a shared-API need across their boundaries. Two issue-local
allowances are added with dated rationale — `src/ir/identity.ts` and
`src/ir/select-identity.ts` cross the 1500-LOC god-file threshold for the first
time, and `src/codegen/index.ts::planIrOverlay` grows 628 → 652 because the
resolver, the proof and the marker must all be constructed there, before
selection, and handed to five call sites in the same function. No budget
baseline file was edited.

F4 remains `in-progress` work under #3522. Not yet covered, and deliberately
left specified rather than half-implemented: the wider families the spec
already excludes (static fields, heritage, computed names, member/imported/
cross-source targets), and the pre-existing nested-executable-in-a-member
failure that F4 routes around rather than fixes — that shape is broken for the
CALL-FREE bounded family too and belongs to its own slice.

#### 2026-08-29 correction — accessors leave the first admitted family

The first F4 push turned `quality` red on the accessor suite's
"does not grow the optimized binary versus the direct control" row. The
checkpoint above attributed that row to a container artifact. **That
attribution was wrong, and the A/B that produced it was run but not read
carefully enough**: reverting only the eleven F4 source files to
`origin/main` and re-measuring gives, for all three fixtures in that row,
byte-identical numbers and byte-identical claimed-unit sets —

| fixture | rawDirect | rawPrepared | optDirect | optPrepared |
| --- | --- | --- | --- | --- |
| `METHOD_AND_GETTER` | 683 | 690 | 367 | 367 |
| `GETTER_AND_SETTER` | 1081 | 1007 | 588 | **1007** |
| `CLASS_EXPRESSION` | 4915 | 855 | 4915 | 382 |

identical on `origin/main` `23bc3ddece` and on the F4 branch. So F4 did not
grow that binary. The failing fixture is `GETTER_AND_SETTER`, an
**accessor-only class with no field call**, which F4's admission never
touches: `optPrepared == rawPrepared` because wasm-opt aborts on the prepared
module (`Assertion failed: type.isStruct(), effects.h:650, writesStruct`) and
`optimize` silently returns the unoptimized binary, while the direct module
optimizes 1081 → 588.

It reached CI only because the slice had MODIFIED that file. `test:changed-root`
runs exactly the root test files a branch adds or modifies — `ci.yml`'s own
comment states "Untouched root test files do NOT run at PR time" — and
`tests/guard-suite.json`'s twenty entries contain no `issue-3522` file. So the
row never runs on `main`, and `main` being green was never evidence about it.
Touching the file armed the fix-on-touch ratchet against pre-existing rot the
slice has no remit to repair.

The resolution narrows F4 rather than the bound. **Accessor-bearing classes
leave the first admitted family** (`nestedOrdinaryClassBodyHasAccessor`),
for the same kind of measured reason as the nested-executable exclusion:

1. the F4 plan's positive-coverage list contains no accessor case;
2. F3 already inventories accessor field-call candidates and deliberately
   leaves them unclaimed — its merged suite pins exactly that; and
3. the accessor family's optimized lane is already broken on `origin/main`
   independently of any field call, as the table above shows, so admitting its
   field-call variant would add instances of a known-broken shape rather than
   new compile-once coverage.

With that narrowing, `tests/issue-3522-nested-class-accessor.test.ts` is
restored to `origin/main` byte-for-byte: its
"keeps a nested accessor class whose field initializer CALLS a local function
direct" assertion is TRUE again under F4 (verified passing), the file is no
longer selected by `changed-root`, and that lane returns to main's behaviour
exactly. The accessor boundary is instead pinned where F4 owns it — three new
controls in the F4 suites (two runtime, one marker-level, the last one
asserting that F3 still inventories the candidate and mints its dormant proof
while admission refuses).

Evidence after the correction:

- CI's gate reproduced exactly (`scripts/hooks/changed-root-tests.sh` against
  `23bc3ddece`, `VITEST_FORK_MAX_OLD_SPACE_SIZE=4096`,
  `JS2WASM_EVAL_ENGINE=interpreter`): **5 files selected, 113 tests, exit 0** —
  `issue-3522-ir-nested-class-ownership` 7/7,
  `issue-3522-nested-class-field-call-admission` 40/40,
  `issue-3522-nested-class-field-call-marker` 22/22,
  `issue-3522-nested-class-field` 24/24,
  `issue-3522-nested-implicit-constructor` 20/20.
- All fifteen ratchet/format/lint gates pass, plus the
  `LOC_GATE_BASE=origin/main` simulation for both budgets, and TypeScript 7 and
  5 no-emit.
- Source growth is now `src/ir/select-identity.ts` +158,
  `src/ir/identity.ts` +120, `src/ir/class-accessor-safety.ts` +88,
  `src/codegen/index.ts` +36, `src/codegen/ir-prepared-free-functions.ts` +25,
  `src/ir/from-ast.ts` +24, `src/ir/module-bindings.ts` +14,
  `src/codegen/ir-overlay-identity.ts` +11, `src/codegen/class-bodies.ts` +7,
  `src/codegen/ir-class-shapes.ts` +7,
  `src/codegen/ir-prepared-nested-executable-syntax.ts` +4 — net **+494 src
  LOC**, inside the same allowances.

The other six failures the checkpoint above called pre-existing were re-audited
against the CI lane, not just the container. None of them is in
`tests/guard-suite.json`, and this branch modifies none of them, so
`changed-root` does not select any of them and CI does not exercise them on
this PR: four in `issue-3522-nested-class-static`, one in
`issue-3522-ir-cross-owner-free-function`, one in
`issue-3522-ir-object-method-ownership`. Each was additionally confirmed to
fail with the eleven F4 source files reverted to `origin/main` in the same
container — the correct instrument for "did this slice cause it", which
answers no. Whether they would fail on a CI runner is a separate question this
slice does not answer and does not need to.

The remaining accessor-family defect is real and now explicitly out of scope:
wasm-opt aborts on the prepared accessor module, and `optimize` swallows the
abort and returns the unoptimized binary rather than reporting it. The silent
fallback is the more dangerous half — a crashing optimizer currently reads as a
successful compile. Both belong to the accessor slice, not to F4.

## 2026-09-03 — this issue's claim is a GHOST, and it has blocked R3 for five days

`claim-issue.mjs --check 3522` reports:

```
#3522 is CLAIMED by ttraenkler/opus-3522-f4 (since 2026-08-28T22:01:28Z).
claim-issue: REFUSED (exit 3)
```

**That lane finished on 2026-08-29 and never released.** Evidence, all checked:

| fact | value |
| --- | --- |
| claim holder | `ttraenkler/opus-3522-f4` (slice-named, not epic-named) |
| its branch | `claude/issue-3522-f4-field-call-admission` |
| its PR | **#5199, MERGED 2026-08-29T04:27:46Z** by the merge-queue bot |
| branch vs `main` | **0 ahead, 1299 behind** — nothing left on it |
| any `*3522*` branch moved since | **no** — the other four last moved 2026-08-15/16 |

So the claim on the **bare issue id** outlived the slice that took it by five days.
Every other lane this week claimed a *slice* (`3526:f3s1`, `3521:r2f1`,
`3523:r4m1`) and released on merge; this one claimed the whole issue and did not.

**The cost is concrete.** `claim-issue.mjs` exit 3 is what a dispatcher checks
before starting, and `budget-status --pick` excludes claimed issues from its
recommendations. So R3 — `priority: critical`, `sprint: current`, and the
**second-largest blocker** in the 2026-09-03 dogfood census (the class family is
7 of 33 single-host rejections; see `#3518`) — has been invisible to dispatch
since 2026-08-29 while reading as actively owned.

**Fix, one line:**

```bash
node scripts/claim-issue.mjs --release 3522 ttraenkler/opus-3522-f4
```

**Deliberately not run here.** #3522 is `horizon: xl` and #5199's own body says
"F4 is a checkpoint under #3522, not its completion" — so someone intended to
continue. If that lane is somehow still live, releasing lets a second lane start
the same XL work, which is the duplicate-work hazard CLAUDE.md documents at
length. The evidence says it is not live, but the asymmetry (a five-day-old
ghost costs a day; a duplicated XL slice costs a week) says a human or the next
session should make that call with this evidence in hand rather than have it
made at 02:00 by a session that is suspending.

**If you release it**, the next slice is well-specified: the class family in the
dogfood census is `class-member-unsupported` ×4, `class-projection-unsupported`
×2, `class-method` ×1, plus `static-class-initialization` ×1 on the module-init
side — 7–8 units, second only to R4's module-init blocker.

### Addendum — the session evidence is weaker than it looks, and here is why

Before suspending I went looking for the one fact that would settle it: does
the F4 lane's session still exist? `list_sessions` (100 rows, back to
2026-07-17, so the 2026-08-28 claim window is covered) has **no row for
`opus-3522-f4`**. The 12 rows in the 08-27..08-29 window are:

| created (UTC) | status | title |
| --- | --- | --- |
| 08-28 21:44 | **RUNNING** | IR migration |
| 08-28 21:58 | archived | PR #23 repository migration |
| 08-28 22:36 | idle | Deno integration |
| 08-28 23:13 | idle | ES edition feature list currency |
| 08-29 00:53 | idle | PR #5183 fix |
| 08-29 02:44 | idle | 3520 R1-A review + R1-B repair |
| 08-29 02:44 | idle | 5165 tail loops/try adoption |
| 08-29 02:44 | idle | 5166 nested-vec carrier + 4470 lift |
| 08-29 02:45 | idle | 5167 string-index loop proof |
| 08-29 02:45 | idle | 3521 R2-v2 static collector repair |
| 08-29 07:41 | idle | 3523 R4 gap-1a single-pass module init |
| 08-29 16:29 | idle | Landing page passrate not updating |

**I nearly read that as "no session ⇒ the lane is dead." It does not say
that.** A lane dispatched as an in-process `Agent` subagent never gets a
session row at all, so its absence is consistent with both "gone" and "never
had one." And the timing points exactly there: the claim landed
**2026-08-28T22:01:28Z, seventeen minutes after** the `IR migration` session
opened at 21:44 — the shape of a plan-then-dispatch subagent, not of an
independent lane. Note that session is the one row still marked **RUNNING**.

What the table *does* establish is narrower and still useful:

- **Every sibling R-slice from this same window has its own session row**
  (R1 #3520, R2 #3521, R4 #3523) — and every one of those released its claim
  on merge. #3522 is the only R-slice of that week with neither.
- **There is no session anyone can reattach to** to ask the F4 lane whether it
  intends to continue. Whatever it was, it is not reachable.

So the release decision rests where it already did — on the merged PR, the
0-ahead/1299-behind branch, and five days of no branch movement — and **not**
on this listing, which cannot distinguish a dead lane from a subagent. The one
thing worth checking before releasing that I could not: whether the
still-RUNNING `IR migration` seat considers F4 unfinished work of its own.

## Measurement 2026-09-03 — class-arm census

Run on `origin/main` **`42a0adf7d47579e4632c7ddd4b82f6e5732cb7bf`** ("Merge pull
request #5535"), through the production `compile` seam with
`experimentalIR: true, trackIrOutcomes: true` and `JS2WASM_IR_SHAPE_DIAG=1`,
sequentially in one process, over the full census population the #5285 survey
used: **`tests/dogfood/corpus` (20 `.js`) + `website/playground/examples` (13
`.ts`) = 33 entries × 2 lanes = 66 compiles**. No source was edited; the probe
harness is `.tmp/` only.

### Instrument validation

The run reproduces #3518's 2026-09-03 dogfood census: 35 terminal units per
lane, 33 unsupported / 1 emitted / 1 non-executable on single-host, 31
unsupported on standalone, and the class family at exactly
`class-member-unsupported ×4`, `class-projection-unsupported ×2`,
`class-method ×1`, `static-class-initialization ×1` — **identical on both
lanes**. Two non-class buckets have drifted since that census as main advanced
(`body-shape-rejected` 19→18 sh / 16→14 sa; `template-substitution-unsupported`
and, on standalone, `string-method-unsupported` are now split out). The class
family has not moved.

| corpus | lane | units | emitted | unsupported | non-exec |
| --- | --- | --: | --: | --: | --: |
| dogfood (20) | single-host | 35 | 1 | 33 | 1 |
| dogfood (20) | standalone | 35 | 0 | 31 | 4 |
| playground (13) | single-host | 73 | 54 | 8 | 11 |
| playground (13) | standalone | 73 | 48 | 14 | 11 |

**Finding 0 — the class family is ONE FILE.** All 16 class-family refusal rows
(8 units × 2 lanes) come from `tests/dogfood/corpus/classes.js`. Every one of
the **20 playground `class-member` rows is `emitted`** on both lanes: classes
already compile once on that corpus. There is no second file to generalise
from.

**Finding 1 — the `detail` string does not name the arm for these codes.** The
brief assumed `detail` could be mapped to a source line. It cannot here:
`src/codegen/ir-overlay-outcomes.ts:827` composes
`` `${unit.matchName} rejected by IR selection (${fallback.reason})` `` whenever
the identity fallback carries no detail, so every class row reads
`Animal_get_label rejected by IR selection (class-member-unsupported)` — the
code restated, zero arm information. `JS2WASM_IR_SHAPE_DIAG=1` adds arm detail
for `body-shape-rejected` and for #5285's module-binding refusals, **not** for
the class reasons. The arms below were therefore established by source reading
plus **fixture bisection**, which is the only instrument that currently answers
this question.

### Raw class rows (both lanes identical; single-host shown)

| unit | file:line | unitKind | code | stage |
| --- | --- | --- | --- | --- |
| `<module-init>` | classes.js:2 | module-init | `static-class-initialization` | select |
| `Animal_new` | classes.js:5 | class-member | `class-projection-unsupported` | select |
| `Animal_get_label` | classes.js:6 | class-member | `class-member-unsupported` | select |
| `Animal_set_label` | classes.js:7 | class-member | `class-member-unsupported` | select |
| `Animal_<computed>` | classes.js:8 | class-member | `class-method` | select |
| `Animal_make` | classes.js:9 | class-member | `class-member-unsupported` | select |
| `Dog_new` | classes.js:12 | class-member | `class-projection-unsupported` | select |
| `Dog_speak` | classes.js:13 | class-member | `class-member-unsupported` | select |

### Arm map — arm (file:line) → units → lanes

| # | arm | file:line | units firing | lanes |
| --- | --- | --- | --- | --- |
| **A1** | **root: class position type is `any`** → `ctorOk = false`, class never enters the shape sidecar | `src/codegen/index.ts:1633` (predicate `tsTypeToClassPositionIr` `:2032`), gate `:1646`. Same-cause twin for fields: `:1747`, gate `:1752` (via `valTypeToIrField` `:2059`, which returns null for string/externref with no AST evidence) | `Animal`, `Dog` (⇒ **6 units**) | gc + sa |
| A1a | downstream stamp, constructors: `projectionGap && !isStaticMethod` | `src/ir/select-identity.ts:1334` (`localClassHasKnownProjectionGap` `src/ir/select.ts:8039`, which is `!projectedClassShapes.has(className)`) | `Animal_new`, `Dog_new` | gc + sa |
| A1b | downstream stamp, non-constructors: no exact member descriptor | `src/ir/select-identity.ts:1329` | `Animal_get_label`, `Animal_set_label`, `Animal_make`, `Dog_speak` | gc + sa |
| **A2** | **member NAME not phase-1 representable** (`PrivateIdentifier` / `ComputedPropertyName`) | `src/ir/select-identity.ts:1286`; predicate `phase1MemberName` `src/ir/select.ts:10495`; the `<computed>` display name is minted at `src/ir/identity.ts:602-605` (`memberBaseName`) and composed at `:607` | `Animal_<computed>` (`#privateMethod`) | gc + sa |
| A3 | static class initialization on the module-init unit | `src/ir/identity.ts:890` | `<module-init>` | gc + sa |

A1a and A1b are **not independent arms** — they are two stamps of one fact
(`Animal`/`Dog` absent from the projected class-shape map). The census's
`class-member-unsupported ×4` and `class-projection-unsupported ×2` are the same
root cause seen from the member side and the constructor side.

### Bisection — the measurement that establishes A1

Additive probes, each compiled on both lanes (`.tmp/probes`, results identical
gc/standalone unless noted):

| probe | shape | outcome |
| --- | --- | --- |
| `p01` | **untyped `.js`** class: ctor + one method | `Animal_new=class-projection-unsupported`, `Animal_speak=class-member-unsupported` |
| `p02` | **the same class, annotated `.ts`** | **all units claim (IR)** |
| `q01` | untyped, but `.ts` | refused, identically to `p01` — **the `.js` extension is not the discriminant** |
| `q02` | field declared, ctor param untyped | refused ⇒ the **ctor-position** arm (`:1633`) |
| `q03` | ctor param typed, field not declared | refused ⇒ the **field** arm (`:1747`) |
| `p03`/`p04`/`p05`/`p06`/`p08` | annotated getter+setter / static method / static field / private FIELD / extra field | **all claim** |
| `q06` | annotated twin of `classes.js` minus `#privateMethod` and minus `extends` | **every class unit claims**; only `<module-init>` still refuses (`static-class-initialization`) |
| `q05` | full annotated twin of `classes.js` | accessors claim; `Animal_<computed>=class-method`; ctors `late-preparation-unsupported`; `Dog_speak=body-shape-rejected` |

Checker probe on the arm inputs (`.tmp/arm-probe.ts`, TypeScript API,
`tests/dogfood/corpus/classes.js`): `Animal`'s and `Dog`'s constructor parameter
`name` both have type **`any`** (flags `0x1`), and `this.name` / `this.legs`
are `any` as well. `tsTypeToClassPositionIr` returns null for `any` (it admits
only NumberLike / BooleanLike / StringLike / a projected class / an object IR
type), so `ctorOk` is false at `:1633` for both classes, and the gate at `:1646`
drops them before the field and method loops are ever reached.

**Consequence, stated plainly: 6 of the 8 class units in the census are not a
class-coverage gap. They are unannotated-`any` class positions.** The identical
class shapes — implicit-ctor, getter, setter, static method, static field,
private field, extra instance field — all compile once today when annotated
(`q06`). Reading this cluster as "R3 class members" would repeat exactly the
error #3518 recorded twice: a reason label names a demote path, not a feature
area.

### Cost of the A2 (private-method) arm, measured

| probe | shape | units lost |
| --- | --- | --- |
| `r01` | private method **declared, never called** | **1** (`Animal_<computed>`); ctor, sibling method and `run` all claim |
| `r03` | private method called from the constructor | 2 (`Animal_new` → `body-shape-rejected`) |
| `r02` | private method called from a sibling method | 3 (ctor → `late-preparation-unsupported`, sibling → `body-shape-rejected`) |
| `r04` | private **field** only, read from a method | **0 — already claims** |
| `r05` | computed-name method `["tagged"]()` | 1, same arm (`class-method`) |
| `r06` | generator method `*gen()` | 1, but a **different** arm — `class-member-unsupported` via the descriptor drop at `src/codegen/index.ts:1763` (`asteriskToken`) |

`classes.js:8` is the `r01` shape: `#privateMethod` is never called, so on the
census this arm costs exactly one unit per lane and produces **no cascade**.

**Latent naming defect found while measuring (`s01`/`s02`).** Two private
methods in one class both take the display/legacy-match name
`Animal_<computed>` — `memberBaseName` (`src/ir/identity.ts:602-605`) returns
the same literal for every `PrivateIdentifier` and every
`ComputedPropertyName`. Today this is inert because both members are refused
and never mint a callable slot. It becomes load-bearing the moment either is
admitted: a second private method would overwrite the first's exact UnitId in
the legacy callable slot — the same hazard the accessor slice guarded with
`occupiedAccessorSlots`. Any admission of this arm must introduce a distinct
name **before** claiming.

## Implementation Plan — W1-A class-member family (2026-09-03)

### What the census changed about this slice

W1-A was briefed as "one PR over the `class-member-unsupported` ×4 cluster,
after an arm-level census says all four fire on the same arm." The census says
they **do** fire on one arm — and that arm is **A1, an `any`-typed class
position**, not a class-member shape. So the briefed slice does not exist as
briefed. This plan therefore does two things: it disqualifies A1 with reasons,
and it dispatches the largest arm that is genuinely class-shaped, in-scope, and
test262-representative.

**Why A1 is not this slice**, three measured reasons:

1. **It is a type-resolution arm.** `q06` proves the identical class shapes
   claim once annotated. Fixing A1 means deciding how an `any` class position
   is carried (boxed / dynamic), not widening class-member admission.
2. **It belongs to another lane.** The `any`-carrier decision is #5289 /
   #3523 territory (module-binding `any` ABI landed in PR #5525); duplicating
   it here is the cross-lane duplication CLAUDE.md documents at length.
3. **Blast radius.** It changes the class-shape sidecar for *every* class in
   *every* unannotated file, on both lanes — the opposite of a bounded slice.

Record it as R3's largest measured cluster and hand the mechanism to the `any`
lane; do not implement it under W1-A.

### Chosen cluster — A2, PrivateIdentifier instance-method declarations

Scope: **admit a `PrivateIdentifier`-named, non-static, non-generator,
body-bearing instance METHOD DECLARATION into the ordinary bounded class-member
family.** Computed names stay refused. Private-method **call sites** (`r02`/`r03`,
2–3 units, an `src/ir/from-ast.ts` lowering question) are explicitly the *next*
slice, not this one.

Why this one:

- It is the largest **class-shaped** arm on the census (1 unit × 2 lanes) once
  A1 is removed, and the only one whose fix is a member-admission change.
- **It is the single most test262-representative class shape we have.** #3518
  measures `PrivateIdentifier` at **4.58 % of test262 nodes vs 0.21 %
  (playground) / 0.23 % (dogfood)** — the largest blind spot in both denominators
  by an order of magnitude.
- Measured cost is bounded and cascade-free in the census shape (`r01`).
- The legacy substrate already exists and agrees:
  `resolveClassMemberName` (`src/codegen/class-bodies.ts:752-761`) already maps
  `#x` → `__priv_x`, and the field path in `buildIrClassShapes`
  (`src/codegen/index.ts:1682`) already uses the identical mangling. This slice
  makes the IR member path agree with two conventions that are already in the
  tree; it invents no naming.

### Root cause

A `PrivateIdentifier`-named method fails `phase1MemberName`
(`src/ir/select.ts:10495`, which returns `null` for `PrivateIdentifier` and
`ComputedPropertyName` alike), so `src/ir/select-identity.ts:1286` stamps
`class-method` before any descriptor is consulted. Independently, the descriptor
loop in `buildIrClassShapes` skips the member at `src/codegen/index.ts:1762`
(`if (!ts.isIdentifier(member.name)) continue`), so no descriptor exists for it
either. And `memberBaseName` (`src/ir/identity.ts:602-605`) gives every such
member the same name, `<computed>`.

**All three must move together.** Relaxing only the name predicate moves the
row from `class-method` (A2) to `class-member-unsupported` (A1b, the
missing-descriptor arm) and claims nothing — the exact trap recorded in the
2026-08-15 accessor measurement ("Relaxing gate 1 alone moved every fixture from
`body-shape-rejected` to `class-member-unsupported` and claimed nothing").
Relaxing the name without the mangling re-admits the `s01` collision.

### Changes, in this order

**Step 0 (measurement, before any edit).** Re-run the probe set at the branch
base and record the current rows for `r01`, `r02`, `s01`, `s02` and
`tests/dogfood/corpus/classes.js` on **both** lanes. Capture the base copies of
every file this slice touches (`cp src/… .tmp/base-….ts`) at the *first* edit,
per CLAUDE.md's A/B rule — the acceptance criteria below require a base run.

**1. `src/ir/identity.ts` — `memberBaseName` (`:602-605`).**
Return `"__priv_" + name.text.slice(1)` for a `PrivateIdentifier`; leave
`ComputedPropertyName` returning `"<computed>"` unchanged. This is the naming
substrate for both the display name and the legacy match name composed at
`classMemberLegacyName` (`:607-616`), so `#first` becomes `Animal___priv_first`
— byte-agreeing with what `resolveClassMemberName`
(`src/codegen/class-bodies.ts:754`) already produces on the legacy side.
`memberBaseName` is also read by `objectMemberDisplayName` (`:620-627`); an
object literal cannot carry a private name, so that call site is unaffected —
assert it with a test rather than assuming it.

**2. `src/ir/select.ts` — `phase1MemberName` (`:10495-10501`).**
Return the same mangled name for a `PrivateIdentifier`; keep `null` for
`ComputedPropertyName`. Use one shared helper so steps 1 and 2 cannot drift —
put it beside `phase1MemberName` and have `memberBaseName` call it. Do **not**
touch the accessor arm at `select-identity.ts:1294`; private accessors are out
of scope for this slice and must stay refused (negative test).

**3. `src/codegen/index.ts` — the method-descriptor loop (`:1756-1800`).**
Widen `:1762` from `!ts.isIdentifier(member.name)` to also admit a
`PrivateIdentifier`, using the same helper, and mint `methodName` from it. The
static defer (`:1760`), the abstract defer, and the generator defer (`:1763`)
are unchanged. **This function is `buildIrClassShapes` (`:1519`), ~1,300 lines
above `planIrOverlay`; the standing instruction to stay out of `planIrOverlay`
is respected.** PR #5530, which held this file, **merged** (`54bfb99c90`, on
main at the base sha) — verified, so the file is free. Re-verify at branch time.

**4. `src/codegen/class-bodies.ts` — verify only, edit only if measured.**
`resolveClassMemberName` (`:752`) already yields `__priv_x`. Confirm the
prepared class-body route emits and dispatches the admitted member under that
name on both lanes; if it does, this file is audit-only and the slice does not
edit it. Do not "fix" it speculatively.

**5. Do NOT touch** `src/codegen/prepared-class-body-cutover.ts` unless a
measured failure requires it (it is the `JS2WASM_PREPARED_CLASS_ROUTE_CUTOVER`
hatch, R9 inventory row 12 — changing it moves a retirement denominator).

### What this must NOT change

- **Order preservation.** Field initialization must still precede constructor
  body reads, and member declaration order must be unchanged. Reuse the F4
  ordering control (`40100`, where every wrong ordering yields `0` or `NaN`).
- **Byte identity for programs without a private method.** Every entry in the
  census cohort that carries no `PrivateIdentifier` member must be
  byte-identical to base, on both lanes. This is the primary safety property:
  step 1 edits a naming helper on a shared path.
- **Computed names stay refused** (`r05` keeps its `class-method` row), private
  **accessors** stay refused, **generator** methods keep their `class-member-unsupported`
  row via `:1763` (`r06`), **static** private methods stay deferred via `:1760`.
- **The `s01`/`s02` collision must be closed, not inherited.** Two private
  methods, and a private method beside a computed-name method, must resolve to
  distinct names and must not overwrite each other's UnitId.
- **A1 must not move.** `tests/dogfood/corpus/classes.js` keeps its 6 A1 rows
  after this slice; only `Animal_<computed>` changes. A run that "improves"
  A1 means step 3 widened something it should not have.
- **No new import, runtime representation, ABI, or lowering surface.** If one
  appears to be needed, the slice is wrong — stop and re-measure.

### Tests to add (must be RED on base)

`tests/issue-3522-private-method-admission.test.ts`, both lanes, direct class
and function emitters poisoned (`JS2WASM_TEST_POISON_DIRECT_CLASS_BODY`), with a
positive control proving the poison seam is live so no assertion can pass
vacuously:

1. `r01` — private method declared, never called: the member claims (IR) and
   the class's other units stay claimed. **Red on base** (`class-method` today).
2. Runtime equality legacy↔IR for that fixture, both lanes.
3. `s01` — two private methods: distinct unit names, both admitted, no UnitId
   overwrite; assert the two rows carry different `displayName`s. **Red on base**
   (both read `Animal_<computed>`).
4. `s02` — private method beside a computed-name method: the private one
   claims, the computed one keeps `class-method`.
5. Negatives, each asserted identical to base: private **accessor**, **static**
   private method, **generator** method (`r06` keeps `class-member-unsupported`),
   computed name (`r05`).
6. Call-site controls pinning the deferral: `r02` and `r03` keep their exact
   current rows (3 and 2 units lost). These are the next slice's boundary and
   must not silently move.
7. A1 control: `tests/dogfood/corpus/classes.js` keeps 6 A1 rows on both lanes.
8. WAT proof on the admitted fixture: no `call_ref`, `call_indirect`,
   `ref.test`, ambient `this`, boxing, or `__call_m_*` in the prepared owner.

### Byte-identity cohort

Per-row **sha256** over the emitted binary for **all 33 entries × 2 lanes**
(dogfood 20 + playground 13; gc and standalone), base vs branch, with the
diagnostic OFF. Expected: **65 of 66 identical**; the sole permitted mover is
`tests/dogfood/corpus/classes.js`, whose two rows change because
`Animal_<computed>` is admitted. Publish the full table, and publish the two
changed digests explicitly with the claimed-unit set before and after. A second
mover is a stop-and-diagnose, not a rebaseline. Reuse `.tmp/census-3522.ts`
(add a `sha256` over `result.wasm`); it is a `.tmp` instrument, not a shipped
script.

### Gates

Run bare (never piped — a piped gate reports the pipe's status), chained so a
failure blocks, before the commit:

```bash
node scripts/check-loc-budget.mjs && node scripts/check-func-budget.mjs \
  && node scripts/check-coercion-sites.mjs && npm run -s check:oracle-ratchet \
  && npm run -s check:dead-exports
```

plus, and each named because this slice can move it:

- `LOC_GATE_BASE=$(git rev-parse origin/main) node scripts/check-loc-budget.mjs`
  and the same for `check-func-budget` — CI diffs the merge preview, not the
  fork point. Any growth allowance goes in **this issue file's** frontmatter
  with a dated rationale; never edit `scripts/*-baseline.json`.
- `npm run -s check:ir-dialect`.
- `npm run -s check:ir-kind-neutrality` — steps 2 and 3 add lines to
  `src/ir/select.ts` and `src/codegen/index.ts`, which is exactly what has
  relocated evidence line anchors on the last two checkpoints (F2, F4). Expect
  an evidence-location-only diff; **re-lock the baseline sha256 and state in the
  commit that no row, verdict, placement, rationale or phase-two move changed.**
- `pnpm run check:ir-fallbacks` — name the class buckets in the result:
  `class-member-unsupported`, `class-projection-unsupported`, `class-method`,
  `static-class-initialization`. `class-method` should **decrease**; the other
  three must not move. Use `--update-on-decrease` only for a real decrease.
- `npm run -s check:ir-only` — must stay **READY**, single-host and standalone.
  The five gate entries contain no private members, so this is a no-move check.
- `gen-ir-adoption --check` byte-clean, TypeScript 7 and 5 no-emit, Prettier,
  Biome, IR layering.
- `scripts/hooks/changed-root-tests.sh` against the branch base, reproducing
  CI's `test:changed-root` selection — and read the 2026-08-29 F4 correction
  above before dismissing any failure in a file this branch touches: touching a
  root test file arms the fix-on-touch ratchet against pre-existing rot.

Never `--no-verify`.

### Acceptance criteria

1. On `tests/dogfood/corpus/classes.js`, `Animal_<computed>` becomes an admitted
   IR-emitted unit named `Animal___priv_first`-style (mangled, not `<computed>`),
   on **both** lanes, with `legacyBodyEmitted: false`.
2. The other 7 class rows of that file are **unchanged**, including all 6 A1
   rows and the `<module-init>` `static-class-initialization` row.
3. The byte-identity cohort is 65/66 identical with the one documented mover.
4. All 8 test groups above pass on both lanes; groups 1 and 3 are demonstrably
   RED on the branch base (show the base failure output).
5. Every gate above passes, including the `LOC_GATE_BASE` simulation, with the
   kind-neutrality baseline re-locked and its diff characterised.
6. `check:ir-fallbacks` shows `class-method` decreased and no other bucket —
   class or otherwise — increased.
7. No new import, ABI, runtime representation, or lowering surface, evidenced by
   the WAT assertion in test group 8.

### Blast radius and conflict check

Files this slice owns: `src/ir/identity.ts`, `src/ir/select.ts`,
`src/codegen/index.ts` (`buildIrClassShapes` only), optionally
`src/codegen/class-bodies.ts`, and `tests/issue-3522-*`.

Verified against the in-flight set at base sha `42a0adf7d4`:

| constraint | state today | verdict |
| --- | --- | --- |
| `src/codegen/index.ts` / `planIrOverlay`, `src/codegen/ir-overlay-outcomes.ts` (#5530) | **PR #5530 MERGED** (`54bfb99c90`) — the takeover doc's "draft, in flight" is stale | file free; still stay out of `planIrOverlay` |
| #5283 — `ir-overlay-outcomes.ts`, `src/ir/module-init.ts`, `legacy-body-audit.ts` | `status: ready` (queued) | untouched by this slice |
| #5297 — `prepared-dynamic-support.ts`, `prepared-component-sealing.ts`, `compiler-timer-shim-preparation.ts`, `src/ir/integration.ts` | `status: ready` | untouched. **Note:** `late-preparation-unsupported` is raised in `prepared-component-sealing.ts:648/698` — this is why the slice fixes the *cause* (admit the member) and never the cascade |
| #5300 — `src/ir/from-ast.ts` direct-call lowering | `status: done` (PR #5535, at the base sha) | free — but the private-method **call-site** slice will land there, so keep this slice out of `from-ast.ts` entirely |
| #3520 W1-D — `src/codegen/program-abi-*.ts` | untouched | clear |
| `src/ir/integration.ts`, `src/ir/module-bindings.ts` | untouched | clear |

Residual risk, highest first: (a) step 1 edits a naming helper on a shared
path — the byte-identity cohort is the control that catches over-reach; (b)
`check:ir-kind-neutrality` evidence anchors will move; (c) the legacy match name
must agree exactly with `resolveClassMemberName`, so a mismatch surfaces as an
invariant, not a demote — assert the emitted legacy name directly.

### Representativeness

**This arm is the test262-representative one**, which is unusual for this issue
and is the main reason to prefer it over A1's larger count. #3518's 2026-09-03
node-frequency measurement puts `PrivateIdentifier` at **4.58 % of test262 nodes
against 0.21 % (playground) / 0.23 % (dogfood)**, and `PrivateIdentifier` +
`PropertyDeclaration` together at **8.9 % vs 0.4 %** — class bodies are the
single largest blind spot in both denominators, by an order of magnitude. The
`PropertyDeclaration` half is already covered (annotated fields, including
private fields, claim today — `r04`, `p06`), so this slice attacks precisely the
half that is both uncovered and heavily represented upstream. A1, by contrast,
is a shape test262 barely contains at all: test262 is not an unannotated-`.js`
application corpus, so A1's 6 units are close to the maximum that arm will ever
be worth on this census, while A2's 1 unit is close to the minimum it is worth
on the real target population. **Fixture to add to the census** so the arm stops
being invisible: a single file
`tests/dogfood/corpus/class-private-members.js` — one class with a private
field, an uncalled private method, and a private method called from a sibling —
which covers `r01`, `r02` and `r04` in one entry and gives the next slice its
denominator. Adding it changes census counts, so add it in the **same** PR as
this slice or in a dedicated corpus PR, never silently.

### Next cluster, in order

1. **Private-method call sites** (`r02`/`r03`) — 2–3 units per occurrence,
   `src/ir/from-ast.ts` lowering; sequence after #5300's file settles.
2. **`super.<accessor>` in a derived method** (`p09`/`q05`) — the remaining
   genuine class gap in the annotated twin: both ctors
   `late-preparation-unsupported`, `Dog_speak` `body-shape-rejected`.
3. **Computed-name methods** (`r05`) — same A2 arm, but needs a compile-time
   constant-key contract; deliberately excluded here.
4. **A1, the `any` class position** — hand to the `any`-carrier lane (#5289 /
   #3523), not to R3.
5. `static-class-initialization` on `<module-init>` — R4 (#3523), not R3.

### Claim

Claim the **slice**, never the bare id — the bare-id claim is what froze this
issue for five days:

```bash
node scripts/claim-issue.mjs 3522:w1a-private-method ttraenkler/<agent> --branch <branch>
```

Release it on merge. `#3522` itself is `horizon: xl` and remains open after this
slice.
