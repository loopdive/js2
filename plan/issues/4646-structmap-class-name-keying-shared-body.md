---
id: 4646
title: "structMap keyed by class NAME — same-named classes in different functions share one compiled body (silent wrong behaviour)"
status: ready
sprint: current
created: 2026-08-23
updated: 2026-08-23
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen, classes
language_feature: classes, closures
goal: correctness
related: [4627, 4616, 4618]
---

# #4646 — `structMap` keyed by class NAME, so same-named classes share one body

## Problem

Two class declarations with the **same name** in **different functions** are
distinct classes with distinct bodies. The compiler keys `ctx.structMap` by
class name, so the second declaration reuses the first one's compiled body.
Every call to the second class runs the first class's code.

This produces **no invalid Wasm and no compile error**. It is a silent
wrong-behaviour bug, which is why nothing has caught it.

## Concrete instance

`test262`'s `harness/temporalHelpers.js` declares `class MySubclass` in **five**
separate helper functions:

- `checkSubclassConstructorUndefined`
- `checkSubclassConstructorNotCalled`
- `checkSubclassSpeciesNull`
- `checkSubclassSpeciesUndefined`
- `checkThisValueNotCalled`

All five share the first one's compiled class body. So
`checkThisValueNotCalled`'s subclass constructor — which the source writes as
`called = true` — actually executes the **first** helper's constructor, which
does `++called`. The helper's own assertion (`assert.sameValue(called, false)`)
is therefore checking a value produced by code it never wrote.

## Relationship to #4627 — same key, different map

`569d78f7` (#4616/#4618) fixed exactly this keying mistake in
**`classMemberCaptureGlobals`**, re-keying it from class name to the `ts.Node`
declaration. That healed the *capture-global* cross-wiring, which was
producing invalid Wasm (`global.set expected f64, found i32` — #4627).

**`structMap` was not re-keyed and still uses the class name.** So the same
collapse persists one layer down, minus the crash that made the first one
visible. Found while instrumenting #4627; deliberately left out of scope there
because it is an independent defect with a different failure mode.

## Suggested approach

Mirror `569d78f7`'s fix: key `ctx.structMap` (and audit any sibling map keyed
the same way) by the declaration node rather than the name. Check for other
name-keyed class state at the same time — this is now the second instance of
the pattern, so a sweep is likely cheaper than a third round-trip.

Watch for the synthetic-name path: class **expressions** are collected under a
synthetic name (see `src/codegen/statements/nested-declarations.ts`, the
`structMap.has(syntheticName)` branch), so the keying change has to keep that
working.

## Acceptance criteria

1. Two same-named classes declared in different functions compile to distinct
   bodies, and each behaves per its own source.
2. A regression test under `tests/` in the shape that actually occurs: two
   functions, each declaring `class MySubclass`, with **different** constructor
   bodies, asserting each runs its own.
3. A sweep for other class-name-keyed compiler state, with findings recorded
   even if nothing else turns up.
4. No net regression on the test262 baseline. Note that this may *change*
   results in `test/built-ins/Temporal/**` — those five helpers currently run
   the wrong constructor, so tests depending on them may flip in either
   direction. Investigate any flip rather than assuming it is noise.

## Notes

The test262 impact is not estimated. Five harness helpers are affected and they
are used across the Temporal suite, but how many tests observe the difference
is unmeasured — do not quote a number that has not been measured.
