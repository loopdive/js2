---
id: 4713
title: "ES2015 for-of head scope without a variable environment"
status: in-progress
sprint: current
created: 2026-08-25
updated: 2026-08-25
priority: high
horizon: m
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: for-of
es_edition: 2015
goal: es6
related: [4706]
loc-budget-max: 180
---

# #4713 — ES2015 for-of head scope without a variable environment

## Scope

This issue owns the synchronous `for (let ... of ...)` head case where the
specification does not create a separate variable environment. The exact
Test262 row is:

- `language/statements/for-of/scope-head-var-none.js`.

The related controls cover the same no-head-environment behavior for `for-in`
and classic `for`, plus the existing for-of head/body `var` controls. The
implementation must remain within 180 changed compiler-source lines.

This issue explicitly excludes lexical TDZ behavior (#4700/#4710), post-loop
binding restoration (#4709), fresh per-iteration bindings (#4702), unrelated
destructuring changes, async for-of, collection iteration, and IteratorClose
semantics.

## Live baseline

Measured on live `upstream/main` `cd1677bcef59de3d7882125bf8fdce9ff82e7149`
(2026-08-25), with the Test262 submodule at
`b363f29d3c43c626dc852744ad64a0b48a003693`, using the authoritative local
`runTest262File` runner, the original harness, and a 30-second timeout. Each
row was run in a fresh Node process to avoid cross-test compiler state.

| Row | Baseline | Observed signature |
| --- | --- | --- |
| `for-of/scope-head-var-none.js` | fail | `probeBefore()` is `1`, expected `2` (the preceding top-level `var x` reference does not observe direct-eval `var x = 2`). |
| `for-in/scope-head-var-none.js` | fail | `probeBefore()` is `1`, expected `2`; same head-scope signature. |
| `for/scope-head-var-none.js` | fail | `probeBefore()` is `0`, expected `2`; classic-for control exposes the same var-environment mismatch. |
| `for-of/head-var-bound-names-dup.js` | pass | duplicate `var` head names remain accepted. |
| `for-of/head-var-bound-names-in-stmt.js` | pass | `var` head names used in the statement remain correct. |
| `for-of/head-var-bound-names-let.js` | pass | `var`/`let` bound-name early-error control remains correct. |
| `for-of/scope-body-var-none.js` | pass | non-lexical body control remains correct. |

The exact failing row's compiled wasm SHA was `6b306f04aa4b`; the related
`for-in` and classic `for` rows were `58781f0affce` and `193b5a1a6a25`.

## Signature and working hypothesis

The exact row evaluates `eval('var x = 2;')` in the right-hand side of a
lexical for-of head whose names are not referenced by that expression. Under
the no-variable-environment path, direct eval's `var` declaration must target
the surrounding variable environment, so all existing closures and post-loop
reads observe `2`. Current lowering leaves the outer `x` at `1`; the failure
appears before any post-loop restoration or fresh-binding assertion.

The working hypothesis is that the direct-eval environment classification
incorrectly treats this lexical iteration head as a binding boundary even when
the head does not require a TDZ environment. The implementation must confirm
that hypothesis against the for-of lowering and preserve the already-green
bound-name and body-var controls.

## Plan

1. Trace direct-eval classification and synchronous for-of head setup on the
   exact failing row, then confirm the smallest shared cause with the `for-in`
   and classic-`for` controls.
2. Implement a bounded correction for the no-variable-environment head path,
   without changing lexical TDZ setup, per-iteration binding creation,
   post-loop restoration, iterator choice, or IteratorClose handling.
3. Add a focused regression test covering the exact row and the related
   controls; retain the passing bound-name/body-var rows as guards.
4. Re-run the exact and control rows, type-check/lint the touched files, merge
   the latest upstream main without rebasing, and record post-merge results.

## Acceptance

- `for-of/scope-head-var-none.js` passes through the original Test262 harness.
- The related `for-in` and classic-`for` head-var controls pass, unless a
  confirmed independent implementation boundary is documented.
- `head-var-bound-names-dup.js`, `head-var-bound-names-in-stmt.js`,
  `head-var-bound-names-let.js`, and `scope-body-var-none.js` remain passing.
- No lexical TDZ, fresh-binding, post-loop, destructuring, async, collection,
  or IteratorClose behavior is claimed as part of this issue.
- Changed compiler source stays at or below the 180-line budget.
- The exact commands, commit, and before/after statuses are recorded in
  `## Test Results`.

## Test Results

Baseline (no source edits):

```text
upstream/main: cd1677bcef59de3d7882125bf8fdce9ff82e7149
test262:       b363f29d3c43c626dc852744ad64a0b48a003693
runner:        runTest262File, original harness, 30000 ms timeout

for-of/scope-head-var-none.js:       fail — probeBefore() 1, expected 2
for-in/scope-head-var-none.js:       fail — probeBefore() 1, expected 2
for/scope-head-var-none.js:          fail — probeBefore() 0, expected 2
for-of/head-var-bound-names-dup.js:  pass
for-of/head-var-bound-names-in-stmt.js: pass
for-of/head-var-bound-names-let.js:  pass
for-of/scope-body-var-none.js:       pass
```
