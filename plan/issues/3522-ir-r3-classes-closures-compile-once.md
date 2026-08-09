---
id: 3522
title: "IR-only R3: compile-once classes, members, and closures"
status: in-progress
sprint: current
created: 2026-07-21
updated: 2026-08-09
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
  - src/ir/identity.ts
  - src/ir/program.ts
  - src/ir/prepare.ts
  - src/ir/nodes.ts
  - src/ir/select.ts
  - src/ir/from-ast.ts
  - src/ir/integration.ts
  - src/ir/prepared-component-dependencies.ts
  - src/codegen/class-bodies.ts
  - src/codegen/class-constructor-wrapper.ts
  - src/codegen/closures.ts
  - src/codegen/declarations.ts
  - src/codegen/ir-prepared-free-functions.ts
  - src/codegen/ir-overlay-outcomes.ts
  - src/codegen/program-abi-class-callable-planning.ts
  - src/codegen/program-abi-session.ts
  - src/codegen/program-abi-type-planning.ts
  - src/codegen/context/types.ts
  - src/codegen/index.ts
  - tests/class-expressions.test.ts
  - tests/issue-3522-ir-class-compile-once.test.ts
  - tests/issue-3522-ir-static-class-method.test.ts
loc-budget-allow:
  - src/codegen/class-bodies.ts
  - src/codegen/index.ts
  - src/ir/select.ts
func-budget-allow:
  - src/codegen/class-bodies.ts::collectClassDeclaration
  - src/codegen/index.ts::buildIrClassShapes
  - src/ir/prepared-component-dependencies.ts::collectFunctionEvidence
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
- `check:linear-ir` has a pre-existing current-main ratchet failure
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

Resumability before publication: this checkpoint is on
`codex/3522-constructor-retirement` in the isolated worktree
`/private/tmp/ts2wasm-3522-constructor-retirement`. It began at
`49cab5c821297b`; rebase onto the then-current `origin/main`, rerun the measured
37/22 readiness gates, publish a ready PR, and replace this paragraph with the
final head/base/PR and gate evidence before suspension. The dirty root checkout
is outside this worktree and must remain untouched.

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
pnpm exec vitest run tests/issue-3522-ir-class-compile-once.test.ts tests/issue-3522-ir-static-class-method.test.ts tests/issue-1983-funcmap-collision.test.ts tests/issue-3000-1b.test.ts tests/issue-3000-e.test.ts tests/issue-3144-ir-class-claims.test.ts tests/class-expressions.test.ts tests/nested-class-declarations.test.ts --pool=forks --poolOptions.forks.singleFork=true --no-file-parallelism
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
