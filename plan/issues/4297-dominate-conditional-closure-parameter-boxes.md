---
id: 4297
title: "codegen: dominate conditional closure binding boxes"
status: done
sprint: 78
created: 2026-08-09
updated: 2026-08-18
completed: 2026-08-09
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: closures, bindings, control-flow
goal: dogfood
related: [2692, 4286, 4294]
assignee: "ttraenkler/npm-compat-goal"
loc-budget-allow:
  - src/codegen/class-bodies.ts
  - src/codegen/closures/arrow-phases.ts
  - src/codegen/context/types.ts
  - src/codegen/function-poison-pill.ts
func-budget-allow:
  - src/codegen/class-bodies.ts::compileClassBodiesInner
  - src/codegen/closures/arrow-phases.ts::assignmentTargetWritesName
  - src/codegen/closures/arrow-phases.ts::bindingWrittenBeforeClosure
  - src/codegen/closures/arrow-phases.ts::directInitializedLocalBeforeRegion
  - src/codegen/closures/arrow-phases.ts::canBoxBindingInDominatingParent
  - src/codegen/closures/arrow-phases.ts::planClosureCaptures
  - src/codegen/closures/arrow-phases.ts::emitClosureConstruction
  - src/codegen/function-poison-pill.ts::initializeFunctionPoisonPillContext
---

# codegen: dominate conditional closure binding boxes

## Problem

A mutable closure capture is represented by one ref-cell shared between the
outer function and its lifted closure. The arrow construction path previously
created that cell at the closure's runtime construction site while immediately
re-aiming the enclosing function's compile-time `localMap` at the cell.

When construction appeared in an `if`/loop arm that did not execute, the cell
local stayed null but code emitted later in the enclosing function still read
through it. Hono's `RegExpRouter.add` exposed the nested form: `path` is
normalized first, captured by a callback inside the wildcard/`ALL` route arm,
and read later by `checkOptionalParameter(path)`. A non-`ALL` route skipped the
callback arm and passed null to `charCodeAt` instead of the incoming path.
After that parameter was fixed, the same invariant appeared for the
already-initialized local `const routes = this.#routes`: a later
`Object.keys(routes)` read the null cell when the wildcard arm was skipped.

## Resolution

Keep a stable activation-root instruction buffer while branch compilation swaps
`fctx.body`. For a strict/simple source parameter or a directly declared,
already-initialized local captured from a detached top-level region, create the
canonical box in the dominating root buffer just before that region. Appending
there preserves initialization and normalization performed by preceding
statements. A conservative source-order scan declines the move if the detached
region itself wrote the binding before closure construction.

The closure construction then passes the already-live cell, and every later
outer read/write resolves through the same cell whether or not the branch ran.

## Acceptance criteria

- [x] A method parameter remains readable when its first mutable closure-capture
      site is skipped.
- [x] Constructors, getters, setters, and the Promise on-host constructor carry
      the same stable activation-root buffer as ordinary methods.
- [x] A preceding parameter normalization is preserved when the capture sits in
      nested conditional arms.
- [x] An initialized local remains readable when its first mutable capture site
      is skipped.
- [x] The generated Hono binary creates the `path` ref-cell before the wildcard
      branch and reuses it inside the callback closure.
- [x] Hono advances past both the former `charCodeAt(null)` and
      `Object.keys(null)` failures.
- [x] Potentially unsafe sloppy-arguments aliases and regions with an earlier
      binding write retain the existing lowering rather than being hoisted.
- [x] A `for (var captured in object)` iteration write is not crossed by the
      dominating-box move.

## Result

The focused reductions return the Node values. The real pinned Hono workload
still compiles and validates and no longer routes either `path` or `routes`
through a conditionally-uninitialized cell. It now reaches a distinct later
illegal-cast blocker.

## Verification

- `tests/issue-4297-conditional-closure-parameter-boxing.test.ts`
- `tests/issue-2692-closure-box-eager.test.ts`
- `tests/issue-2758.test.ts`
- `tests/issue-1177.test.ts`
- `tests/issue-859.test.ts`
- `node tests/dogfood/hono-workload-harness.mjs`
