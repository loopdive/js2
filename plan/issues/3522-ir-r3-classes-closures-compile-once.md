---
id: 3522
title: "IR-only R3: compile-once classes, members, and closures"
status: in-progress
sprint: current
created: 2026-07-21
updated: 2026-08-15
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
func-budget-allow:
  - src/codegen/class-bodies.ts::collectClassDeclaration
  - src/codegen/declarations.ts::compileDeclarations
  - src/codegen/function-body.ts::compileFunctionBody
  - src/codegen/index.ts::buildIrClassShapes
  - src/codegen/index.ts::generateModule
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
