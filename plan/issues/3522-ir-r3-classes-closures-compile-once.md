---
id: 3522
title: "IR-only R3: compile-once classes, members, and closures"
status: in-progress
sprint: current
created: 2026-07-21
updated: 2026-08-13
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
  - tests/issue-3522-ir-nested-class-expression-ownership.test.ts
  - tests/issue-3520-inherited-class-integration-abi.test.ts
  - tests/issue-3521-prepared-free-function-routing.test.ts
  - tests/issue-3522-ir-class-compile-once.test.ts
  - tests/issue-3522-ir-cross-owner-free-function.test.ts
  - tests/issue-3522-ir-static-class-method.test.ts
  - tests/issue-3522-test262-shard-completion.test.ts
  - tests/test262-shared.ts
  - tests/issue-3792-ir-optimization-retirement-gate.test.ts
loc-budget-allow:
  - src/codegen/class-bodies.ts
  - src/codegen/declarations.ts
  - src/codegen/index.ts
  - src/codegen/ir-prepared-free-functions.ts
  - src/codegen/program-abi-session.ts
  - src/ir/builder.ts
  - src/ir/from-ast.ts
  - src/ir/integration.ts
  - src/ir/module-bindings.ts
  - src/ir/nodes.ts
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
