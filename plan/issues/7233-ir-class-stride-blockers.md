---
id: 7233
title: "IR class members: static private fields and shape-less JS classes block every stride class unit"
status: in-progress
sprint: current
created: 2026-11-04
updated: 2026-11-04
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
related: [7227, 7223, 2949, 6583]
assignee: "ttraenkler/c-lead"
# 2026-11-04 (#7233): the static-private-field admission is wiring in the
# selector's three assignment/read arms, from-ast's property read/write entry
# points and the integration resolver (which holds the storage resolver: it
# needs only codegen imports integration.ts already has, #3113 layering); the
# JS best-effort rule lives in the new src/codegen/ir-class-member-projection.ts.
# Restates #7227's grants for the same files, so they do not strand once
# #7054 lands.
loc-budget-allow:
  - src/codegen/index.ts
  - src/ir/integration.ts
  - src/ir/select.ts
  - src/ir/from-ast.ts
func-budget-allow:
  - src/codegen/index.ts::buildIrClassShapes
  - src/ir/select.ts::isPhase1StatementListInScope
  - src/ir/select.ts::isPhase1BodyStatement
  - src/ir/select.ts::isPhase1Expr
  - src/ir/select.ts::whyNotIrClaimable
  - src/ir/from-ast.ts::lowerPropertyAccess
  - src/ir/from-ast.ts::lowerPropertyAssignment
  - src/ir/from-ast.ts::lowerMethodCall
  - src/ir/integration.ts::makeFromAstResolver
---

# #7233: the class-member gaps that keep the stride ledger flat

## Problem

#7227 (PR #7054) moved 143 class units onto the IR in a 1524-file class
sample. The stride-40 ledger, however, stayed at **20 class-member IR units**
(standalone). Every remaining stride unit in the class buckets is blocked by
one of the gaps that #7227 listed (see "Remaining gaps" in
`plan/issues/7227-ir-class-sync-member-gaps.md`). Two of those gaps are local
to the class lane and cover ~32 stride units:

| Gap | Stride units | Example |
|---|---|---|
| static private **fields**, plus `this.<field>` in a static body | ~12 | `static #x(v) { this.#xVal = v; return this.#xVal; }` |
| shape-less JS classes: one unprojectable instance method drops the whole class in `buildIrClassShapes` | ~20 | a class with one `async m()`, a destructured-param method or `extends Iterator` |

## Implementation Plan (C lead, 2026-11-04; implement on Opus)

Stack the work on #7227 (branch `issue-7227-ir-class-sync-member-gaps`, PR
#7054). Merge `origin/main` once #7054 lands.

1. **Measure and attribute first.** Build a throwaway copy of the per-reason
   probe (as in #7227; never commit it) and confirm the two buckets on the
   stride. Then list, for each stride unit, the first refusal that would
   remain after this issue's two fixes. That list goes in the PR body.
2. **Static private fields in IR static bodies.**
   - Find how legacy stores a static field (`C.a`, `C.#a`): module global,
     static struct, or something else, and under which mangled name.
     `privateMemberMangledName` / `resolveClassMemberName` from #3522 W1-A
     give the private mangling.
   - Admit reads and writes of that storage from an IR static body when the
     receiver is `this` or the owner class name. Reuse the IR's existing
     module-global load/store, the one module `let` bindings use; do not add
     a new global-access node if one exists.
   - Compound assignment (`this.#a += 1`) only if it falls out of the same
     lowering; otherwise refuse it and list it.
   - Anything the legacy static-field ABI cannot represent stays on legacy:
     accessor-backed statics, static fields with an initialiser that reads
     `this`, `static {}` blocks.
   - `this` in a static body is the class constructor. A subclass receiver
     (`D.sm()` where `sm` writes `this.#a`) must give legacy's answer.
     Legacy does no brand check, so equal to base is required. Probe it.
3. **Best-effort instance-method projection, JS sources only.**
   - In the `buildIrClassShapes` instance-method loop, for `.js` sources
     (`NodeFlags.JavaScriptFile`, the same switch #7227 uses), skip an
     unprojectable instance method instead of dropping the class. The
     skipped method stays a legacy body behind the existing slot ABI.
   - TS sources keep the all-or-nothing rule, so typed-corpus bytes stay
     identical.
   - The skipped method must still be reachable through every legacy path:
     vtable/slot, `super.m()`, method-as-value, and `Object.keys` /
     `hasOwnProperty` on the prototype. Check that the #1370 class-method
     ABI parity guard still holds when IR and legacy bodies sit in one
     class.
4. **Do not touch:**
   - async or generator bodies, which belong to other lanes;
   - `dynamicUsesAreMoveOnly` (#2949 / #7106; coordinate on #6583 first);
   - the untyped `#x(42)` dynamic-parameter bucket, which needs boxing with
     a Program-ABI symbolic ref; #7227 tried it and reverted;
   - the TS-annotated IR getter foreign-receiver trap. That one changes
     every IR instance body and gets its own issue.
5. **Never worse than legacy.** Every newly IR-claimed unit must give the
   legacy-observable result on gc, standalone and wasi. Probes must include
   foreign and subclass receivers, `.call({})`, `Reflect.apply`, detached
   calls, exceptions, `+` and comparisons on field values, and mixed IR and
   legacy methods in one class.

## Acceptance criteria

- Ledger A/B (stride 40, standalone) in the PR body: **class-member IR units
  rise above 20**; `class-member-unsupported` falls; 0 invariants;
  `compileOk` not lower.
- Typed playground, benchmark and equivalence corpus is byte-identical on gc,
  standalone and wasi, or every changed binary is explained and correct.
- A test262 A/B on the route-changed class files plus a sample: no test that
  passes on base fails on head (standalone).
- Test: `tests/equivalence/issue-7233-ir-class-stride-blockers.test.ts`,
  covering per bucket the IR route (`trackIrOutcomes`), the stays-legacy
  routes and the node or base result on all 3 lanes.

## Implementation (2026-11-04, Opus)

Test: `tests/equivalence/issue-7233-ir-class-stride-blockers.test.ts` — per
bucket, the IR route (`trackIrOutcomes`) and the result on standalone, WASI
and gc, plus the stays-legacy cases.

What changed:

1. **Static private fields** (`staticPrivateFieldOwner` in
   `src/ir/private-member-syntax.ts`, `resolveIrClassStaticFieldStorage` in
   `src/ir/integration.ts`). Legacy keeps
   `static #x` of class `C` in one mutable module global
   `__static_C___priv_x` (`ctx.staticProps`, key `C___priv_x`) and lowers
   `this.#x` / `C.#x` in a static method to `global.get` / `global.set`
   with no brand check. A private name is never reflected onto the class
   object, so the global is the only store. The IR now reads and writes the
   same global from a static method of the owner: the selector's read arm and
   both statement-write arms admit it, from-ast emits the existing
   `global.get` / `global.set` (the module-binding instructions), and the
   global is planned as a support binding (`PROGRAM_ABI_GLOBAL_ROLE.
   classStaticField`). Typed for `f64`, `i32`, the lane's dynamic carrier
   (untyped field) and the lane's string carrier; anything else demotes.
   Stays legacy: compound assignment and `++` (no admission), a field whose
   initialiser reads `this`, `accessor` fields, arrows/nested functions in
   the static method, same-named classes. Subclass / `.call({})` /
   `Reflect.apply` / detached receivers read the one global exactly as
   legacy does (node throws a TypeError there; base and head agree).
2. **Best-effort instance-method projection, JS only**
   (`irJsInstanceMethodMaySkip`, the new
   `src/codegen/ir-class-member-projection.ts`). In `buildIrClassShapes` a `.js` class
   with one unprojectable instance method (async, default / destructured
   parameter, unprojectable return) keeps its shape; the method keeps its
   legacy body and gets no descriptor, so every call through the IR refuses
   at selection (the selector already stops at an own unprojected member).
   Never when an ancestor shape has a member of the same name. TS keeps
   all-or-nothing.

### Measurements (base = #7227 head `9ec6e925db`)

- **Ledger, stride 40, standalone**: class-member IR 20 → 21;
  `select:class-member-unsupported` 216 → 218,
  `class-projection-unsupported` 17 → 7, `return-type-not-resolvable`
  20 → 25, `param-type-not-resolvable` 43 → 45 (units of newly shaped JS
  classes move to later, more specific refusals); invariants 0; compileOk
  1081 → 1081.
- **1524-file class sample** (the #7227 sample, standalone, all units): IR
  units 628 → 804 (+176 class-member units in 41 files), 0 lost, 0
  compile-success changes.
- **test262 A/B, standalone**: 543 files (#7227's 536 plus the route-changed
  files): 429 pass / 109 fail / 5 compile_error on both, identical non-pass
  lists.
- **Typed corpus bytes** (playground, benchmarks, equivalence snippets;
  2268 units × gc / standalone / wasi = 6804 compiles): 0 diffs.

### Acceptance criteria not met

- **`class-member-unsupported` falls**: it rises 216 → 218. Units of JS
  classes that now get a shape move from `class-projection-unsupported`
  (−10) to their own member refusal.
- **The stride does not move as the plan estimated (~32 units)**: +1. The
  static-private-field stride units are all of the form
  `static #x(value) { this.#xVal = value; return this.#xVal; }` — 12 units
  (plus 4 class-expression twins) refused by `move-only[concrete]:this`
  inside `dynamicUsesAreMoveOnly`, which this issue may not touch
  (#2949 / #7106, coordinate on #6583). The ~20 "shape-less" units are
  mostly the async / generator / destructured members themselves.

### Remaining first refusals on the stride (class-member units, head)

| First refusal | Units | Owner |
|---|---|---|
| async / generator member | 127 | async IR lanes |
| accessor (private / computed / static, getter usage) | 40 | accessor lane |
| `move-only` scan (dynamic param into a static private field / private call) | 33 | #6583 / #2949 |
| descriptor miss, other | 32 | unattributed |
| default / destructured parameters | 18 | separate issue |
| unannotated JS instance return (foreign-receiver trap guard) | 7 | TS/JS getter trap follow-up |
| misc. (`assert`/`Object` value use, spreads, eval carrier, …) | 20 | various |
