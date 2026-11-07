---
id: 7244
title: "IR class shapes: `class X extends F` where `F` is a compiled top-level function constructor (test262's harness `Iterator` shim) gets no shape"
status: done
completed: 2026-11-05
sprint: current
created: 2026-11-05
updated: 2026-11-05
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
related: [7241, 7243, 7242, 3123, 5153, 6492, 7227, 7235]
assignee: "ttraenkler/c-lead"
---

# #7244: a compiled-function parent drops the whole class from IR shapes

## Problem

In the authoritative test262 lanes, every test that mentions `Iterator` is
assembled with `ITERATOR_BINDING_PREAMBLE` (`scripts/test262-iterator-binding.mjs`):
a compiled `function Iterator() {}` whose `.prototype` is `%IteratorPrototype%`.
So `class X extends Iterator { next() {…} return() {…} }` extends a compiled
**function**, not a lib interface. #7241 (PR #7075) handles only the
lib-interface case and never fires here.

Measured on the harness-wrapped ledger (#7240) over the 221 `extends Iterator`
files (164 compile, 57 proposal-skipped), standalone, main `d468fa1a3c`:
- 248 test-origin class-member units, all legacy; first refusal
  `select:class-member-unsupported` because `buildIrClassShapes`
  (`src/codegen/index.ts` ~L1798) drops the class — `resolveIrParentClassId`
  returns `undefined` for a function-declaration parent — so the selector finds
  no member descriptor.
- A throwaway probe that projects such a class as a root shape compiled
  164/164 with 0 invariants but moved **0** units, because every member then
  stopped at a generic blocker. The largest generic blocker, 35 members whose
  body is `throw new Test262Error()`, is now admitted by #7242 + #7243 (the
  overlay route for S3c-bearing class methods). The others: 172 unannotated
  `next()` returning an object literal (needs the instance dynamic-return
  fallback, blocked on #7235), 29 `new TypeError`, 8 `nontail-module-update`.

Legacy's layout for these classes (WAT, standalone, #5153 F fnctor arm):
`$TestIterator (struct (field $__tag i32) …)` — a **root struct**, no parent
struct, not externref-backed; `_new` returns `(ref null $TestIterator)`,
methods take `(param (ref null $TestIterator))`; `super()` lowers to storing
`self` into `__current_this` and an empty block; inherited helpers
(`.map`, `.take`) resolve at the call site through
`tryCompileStandaloneFnctorLazyMethodMiss`. The class is in
`classDynamicUnresolvedHeritageSet` on standalone and
`fnctorAncestorOfClass(className) === "Iterator"`.

## Implementation Plan (C lead, 2026-11-05; implement on Opus)

Stacked on #7243 (branch `issue-7243-class-component-dyn-abi`, PR #7085).
Merge `origin/main` once #7085 lands.

1. **Measure first, on the wrapped ledger.** Reproduce the 248/0 numbers above
   on your base with a targeted file list (`grep -rl "extends Iterator"
   test262/test`), and record per-member first refusals. Then re-run the
   throwaway root-shape probe on top of #7243 and record how many members
   become IR: the 35 `throw new Test262Error()` members are the expected
   gain. Write both numbers into this file before coding.
2. **Extend the #7241 predicate, do not add a second one.**
   `irClassExtendsLibInterfaceAsRoot` (`src/codegen/classes/ir-lib-interface-root-heritage.ts`)
   reads legacy's recorded layout. Add the compiled-function-parent case as a
   second admitted heritage kind in the same module, keyed on exactly what
   legacy recorded: `classParentMap.get(className) === parentName`, the parent
   is not a local class, `fnctorAncestorOfClass(className) === parentName`,
   the class struct has no supertype, and it is in none of the builtin-parent /
   externref-backed / linked-dynamic representations. Rename the module or
   the function if the name no longer fits; keep one call site in
   `buildIrClassShapes`.
   - The shape marker (`libInterfaceRoot` or a renamed, broader one) must keep
     the selector's existing restriction: super-free, top-level **methods**
     only; constructors (explicit or implicit — they call `super()` into the
     fnctor), accessors (`get next`) and anything reading `super` stay legacy.
   - On gc and wasi, check what legacy does for the same class before
     admitting: if the fnctor arm is standalone-only, the predicate must be
     too (read the actual gate, do not assume).
3. **Interplay with #7243.** The newly shaped members mostly carry
   `throw new Test262Error()`. They must take the overlay route #7243 built.
   Verify on the route dump that they are emitted, not demoted, and that no
   sibling member loses its route.
4. **Do not touch** `dynamicUsesAreMoveOnly`, async/generator lanes, the
   instance dynamic-return fallback (#7235 territory), or the Shepherd's
   getter-callable files (`class-bodies.ts`, `closures/method-trampolines.ts`,
   `program-abi-class-callable-planning.ts`, `method-receiver-this.ts`,
   `property-access-exact-shapes.ts`; reading is fine).
5. **Never worse than legacy.** On gc, standalone and wasi probe: the iterator
   protocol over the subclass (`for…of`, spread, `Array.from`); inherited
   helpers (`.map`, `.take`, `.reduce`) on the subclass; `instanceof Iterator`;
   `return()`/`throw()` closing; exceptions from `next()`; a subclass of the
   subclass; methods as values and via `.call({})` (#7235 shape — no worse
   than base); the harness shim itself declared before and after the class;
   a user-declared `function Iterator(){}` with and without a `.prototype`
   assignment; the same class with `Iterator` also imported or `var`-bound.

## Step 1 measurements (2026-11-05, on #7243 head `083a9e8128`)

Targeted wrapped ledger (the runner's `--target standalone` assembly,
`assembleOriginalHarness` primary variant), the 221 files of
`grep -rl "extends Iterator" test262/test`:

| | base `083a9e8128` | root-shape probe on top of #7243 |
| --- | --- | --- |
| files compiled / proposal-skipped | 164 / 57 | 164 / 57 |
| compileOk | 164 | 164 |
| test-origin class-member units | 248 | 248 |
| … of which IR | **0** | **35** |
| all units IR (any origin) | 1476 | 1511 (+35, 0 lost) |
| invariants | 0 | 0 |

Base first refusal: all 248 `select:class-member-unsupported` (no shape).
The 35 gains are exactly the `throw new Test262Error()` methods
(`TestIterator_return` 14, `ThrowingIterator_next` 13, `IteratorThrows_return`
8), taking #7243's overlay route. Remaining first refusals on the probe:
`class-member-unsupported` 139 (constructors / `get next` / `get return`
accessors and members of classes held back by an accessor sibling — all
intended legacy), `return-type-not-resolvable` 43 (unannotated `next()`
returning an object literal, #7235), `error-constructor-unsupported` 29
(`new Error()`), `body-shape-rejected` 8 (`nontail-module-update`),
`class-projection-unsupported` 4 (`new ReturnCalledError()`).

## Acceptance criteria

- Wrapped ledger A/B (stride 40 **and** the 221-file targeted list,
  standalone): class-member IR units rise (expected ≥ 35 on the targeted
  list); no unit loses IR; 0 invariants; `compileOk` not lower. Raw ledger
  A/B too.
- Typed corpus byte-identical on gc, standalone and wasi, or every changed
  binary explained.
- test262 A/B on the targeted list plus a sample, standalone: no test that
  passes on base fails on head.
- Test: `tests/equivalence/issue-7244-ir-class-shape-compiled-function-parent.test.ts`
  asserting the IR route (`trackIrOutcomes`) for a `throw new F()` method of
  a class extending a compiled function constructor, the stays-legacy routes
  (constructor, `get next`, `super`-using method), and the node/base result
  on 3 lanes.

## Results (2026-11-05, head on `origin/main` after #7085)

Implemented as planned: `irClassExtendsLibInterfaceAsRoot` became
`irClassHeritageIsRootStruct` (module renamed to
`src/codegen/classes/ir-root-struct-heritage.ts`, shape marker
`libInterfaceRoot` → `rootStructHeritage`; still one call site in
`buildIrClassShapes`). The new arm admits exactly what legacy recorded:
`fnctorAncestorOfClass(className) === parentName`, plus the existing
checks (spelled parent in `classParentMap`, not a local class, root struct,
no builtin / externref / linked-dynamic representation). The fnctor layout is
lane-agnostic (`fnctorAncestorOfClass` has no lane gate; only the host
registration in the constructor and the host bridges are gc-only, and both
read the class's legacy constructor / compiled method slots), so the predicate
is not lane-gated. The selector restriction is unchanged: own `super`-free
instance methods only.

- **Targeted wrapped ledger** (221 files, standalone): test-origin
  class-member IR 0 → 35, all units 1476 → 1511 IR, 0 units lost, 0
  invariants, compileOk 164 → 164.
- **Stride-40 wrapped ledger** (standalone): class-member emitted 24 → 25
  (one `legacy` → `both`), 0 invariants, compileOk 1117 → 1117, harness
  origin identical.
- **Stride-40 raw ledger** (standalone): identical (raw has no shim; the
  lib-interface case is #7241's).
- **Typed corpus bytes** (playground + equivalence snippets, 542 units × gc /
  standalone / wasi = 1626 compiles): 0 diffs.
- **Probes** (30 programs × gc / standalone / wasi, base vs head): 0 value or
  trap differences. Covered: `for…of` / spread / `Array.from`, `.map` /
  `.take` / `.reduce` / `.toArray`, `instanceof`, `return()` / `throw()`,
  throwing `next()`, subclass of the subclass, methods as values and
  `.call({})`, shim before and after the class, a user `function F(){}` with
  and without `.prototype` writes, `var`-bound parent (stays legacy), class
  expression (stays legacy), constructors and `get next` (stay legacy),
  `super` users (stay legacy). Side effect: free functions that construct
  such a class (`new X()`) can now claim IR too; same values on every lane.
  Not probed: an imported `Iterator` (no single-file shape for it).
- **test262 A/B, standalone** (`scripts/run-test262-paths.mts`, the 221
  targeted files + every 200th test262 file = 486 rows): identical,
  284 pass / 128 fail / 10 CE / 64 skip.
- Test: `tests/equivalence/issue-7244-ir-class-shape-compiled-function-parent.test.ts`
  (fails on base on the gc / standalone IR-route cases).
- Also (#7085 review nit 1): the #7243 test's `MyErr` fixture is now really
  legacy (a trailing `for…in`; the guard must stay first for the
  self-guarded-constructor recogniser) and the test asserts it.
- **Equivalence gate**: no new regressions (20 failing, all in the known set;
  4625 passing).
