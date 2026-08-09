---
id: 3493
title: "compileMulti must execute top-level globalThis property assignments"
status: done
sprint: 73
completed: 2026-07-20
created: 2026-07-20
updated: 2026-07-21
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: bug
area: compiler
goal: test262-conformance
lane: A
related: [2932, 3362, 3491, 3492]
files:
  - src/codegen/declarations.ts
  - src/codegen/index.ts
  - tests/issue-3493-compile-multi-globalthis-property-representation.test.ts
loc-budget-allow:
  - src/codegen/declarations.ts
  - src/codegen/index.ts
---

# #3493 — `compileMulti` must execute top-level `globalThis` property assignments

## Problem

Honest Test262 fixture-graph execution exposes a multi-source compiler bug that
the project runner previously hid by omitting bare side-effect imports.
`collectDeclarations` drops a top-level assignment rooted at `globalThis`, so a
setup module's observable write never reaches the combined `__module_init`.

The official reproducer is:

```text
language/module-code/top-level-await/pending-async-dep-from-cycle.js
```

Although that test contains an async module cycle, the failure reduces to a
synchronous two-source graph: one module executes `globalThis.logs = []` and
another executes `globalThis.logs.push(...)`. The standalone `compileMulti`
result traps with:

```text
illegal cast [in __module_init()]
```

The emitted WAT confirms that the setter is absent. `__module_init` starts with
the later property read, converts its missing/undefined result to `anyref`, then
casts it to the inferred array vec. The cast is therefore a downstream symptom
of statement elision, not a disagreement between two stored representations.

Once the assignment is retained, a second multi-source parity bug becomes
visible: property lowering reserves `__set_member_nonstrict_logs`, but
`generateMultiModule` never fills its `unreachable` placeholder. The
single-source finalizer already fills the symmetric member-set/get dispatchers.

## Evidence (2026-07-20)

- FYI original-harness standalone, Node 25.9.0, pinned Test262: deterministic
  illegal cast during module initialization.
- The project runner reported a false pass because its fixture resolver ignored
  the test's bare side-effect imports and compiled only the entry module.
- The failure persists in a reduced synchronous multi-source graph containing
  only a `globalThis.logs` array write followed by a property read and `push`.
- Before the fix, the reduced WAT contains the `globalThis.logs` getter and
  array `ref.cast`, but no setter call.
- Retaining the setter alone changes the failure to `unreachable` in the
  reserved `__set_member_nonstrict_logs` placeholder, proving the missing
  multi-source finalizer step independently.

## Acceptance criteria

- Add a compiler-level `compileMulti` regression with one module assigning an
  array to a `globalThis` property and another module reading it and invoking
  `push`.
- The standalone result initializes and runs without an illegal cast, trap, or
  erased side effect.
- Retain assignment operators rooted at `globalThis` without special-casing a
  property name, rewriting Test262 source, or coercing global properties to a
  guessed type.
- Fill member-set and member-get dispatchers reserved by multi-source codegen;
  no emitted dispatcher may keep its `unreachable` placeholder.
- The official fixture graph advances past the historical illegal cast. Any
  remaining top-level-await scheduling mismatch stays scoped to #3492.
- Single-source global-property access, ordinary synchronous `compileMulti`
  graphs, host/GC compilation, and standalone import-leak checks remain green.

## Validation

- Run `tests/issue-3493-compile-multi-globalthis-property-representation.test.ts`.
- Run related property-access and multi-source compiler tests plus TypeScript
  checks.
- Run `pending-async-dep-from-cycle.js` through the honest standalone harness
  under Node 25 and confirm it no longer fails with the #3493 illegal cast.
- Rerun the historical 3,472-path standalone comparison set and verify the fix
  changes this row only for an explained compiler reason.

## Implementation Summary

### What was done

- Retained every top-level assignment operator syntactically rooted at
  `globalThis` in `moduleInitStatements`, independent of the property name or
  assigned value type.
- Brought `generateMultiModule` in line with the single-source finalizer by
  filling every reserved member-set and member-get dispatcher after all source
  files have registered their struct types.
- Added a synchronous two-module standalone regression that stores an array on
  `globalThis`, mutates it from the importing module, and observes the mutation
  through an exported function.

### What worked

- Inspecting the reduced WAT distinguished statement elision from a genuine
  representation conflict: the pre-fix `__module_init` contained the getter
  and array cast but no setter.
- Running after only the collection fix exposed the independent
  `__set_member_nonstrict_sharedValues` placeholder trap. Filling the existing
  deferred dispatcher, rather than bypassing it for this property, preserves
  the general dynamic-property lowering shared by both compiler drivers.
- The completed reduced graph is host-import-free in standalone and returns
  `1`; the host/GC control returns the same result.

### What did not work

- The initial representation-disagreement hypothesis was incorrect. No stored
  array representation existed before the fix because the setup assignment was
  erased.
- Retaining the assignment alone changed `illegal cast` to `unreachable`; the
  multi-source finalizer also had to fill the dispatcher that property lowering
  had reserved.
- The full official top-level-await graph now advances past the illegal cast
  but still throws a Wasm exception during module initialization. That residual
  is the separate scheduling work tracked by #3492.

### Files changed

- `src/codegen/declarations.ts`
- `src/codegen/index.ts`
- `tests/issue-3493-compile-multi-globalthis-property-representation.test.ts`
- `plan/issues/3493-compile-multi-globalthis-property-representation.md`

### Validation results

- Focused and related property/multi-source tests: 28/28 pass (#3493, #2988,
  #2996, #2664, #2674, #2930, and #2931).
- TypeScript `--noEmit`: pass.
- Prettier, issue-ID, issue-spec, LOC-budget, and Test262 hard-error checks:
  pass. The verdict-oracle check remains red only because this branch is based
  on the adopted #3473 runner change; #3493 changes no verdict/scoring file.
- Node 25.9.0 FYI standalone exact official path: historical `illegal cast` is
  gone; residual verdict is `wasm exception during module init` (#3492).
- Direct host/GC control: compile succeeds and the exported observer returns
  `1` after the same cross-module write/push sequence.
