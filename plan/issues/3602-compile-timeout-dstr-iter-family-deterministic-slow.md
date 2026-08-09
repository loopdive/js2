---
id: 3602
title: "perf: compile_timeout bucket (135 rows) is dominated by one deterministic slow-compile family (~56× *-ary-init-iter-get-err-array-prototype dstr tests), not random load flake"
status: ready
sprint: current
created: 2026-07-25
priority: medium
feasibility: medium
reasoning_effort: high
task_type: perf
horizon: m
area: compiler-perf
language_feature: destructuring, iterators
goal: test262-conformance
related: [1589, 3595]
---

# #3602 — the compile_timeout bucket is one pathological compile-time family

## Problem (measured, 2026-07-25)

The baseline (JSONL 2026-07-24) carries **135 `compile_timeout` rows**
(128 in default scope). The working assumption has been "pass →
compile_timeout is a load flake" — random CI-load noise. The filename
distribution says otherwise; the bucket is **systematic**:

| count | filename pattern (after stripping `const-/let-/var-/dflt-/named-/…` prefixes) |
| ----- | ----------------------------------------------------------------------------- |
| 44    | `ary-init-iter-get-err-array-prototype.js`                                    |
| 6     | `static-ary-init-iter-get-err-array-prototype.js`                             |
| 6     | `static-dflt-ary-init-iter-get-err-array-prototype.js`                        |
| 4     | `set-length-array-is-frozen.js`                                               |
| 4     | `set-length-array-length-is-non-writable.js`                                  |
| …     | long tail                                                                     |

**56 of 135 (41%)** are the same test shape: array destructuring whose
iterator acquisition must throw because `Array.prototype` itself is the
poisoned object, instantiated across every binding/context variant (for-of,
arrow, async-generator, class method, static, …).

Determinism check: `language/statements/for-of/dstr/const-ary-init-iter-get-err-array-prototype.js`
compiles **successfully in ~11.5 s** on a loaded 8-core box. That is
pathological compile time for a ~20-line test — under CI shard load the same
compile crosses the 30 s ceiling and flips to `compile_timeout`. So the
bucket is **deterministically slow compiles flapping around a fixed
threshold**, which explains both (a) why the same names recur across runs
and (b) why `pass ↔ compile_timeout` transitions look like "load flake" in
diffs. (#1589 investigated the 2026-05 incarnation of this bucket; the
family has re-grown since.)

False-result accounting: a `compile_timeout` is **baseline-unknown**, not a
false FAIL per se — #3595 already excludes it from the trap ratchet for
exactly this reason — but 135 rows of denominator sit in limbo and flap.

## Fix approach

1. **Profile one family member** (the `const-` for-of variant):
   `node --cpu-prof node_modules/.bin/tsx .tmp/compile-one.mts` (probe file
   in `.tmp/`, compile only, no execute) and identify the hot pass. Given
   the family shape, prime suspects are destructuring lowering
   (`src/codegen/statements.ts` dstr paths) or type-oracle queries against
   the mutated `Array.prototype` element type — but **profile first, do not
   guess** (this issue deliberately ships no root-cause claim).
2. Fix the hot spot (memoize / short-circuit whatever is super-linear).
3. Acceptance: each family member compiles in **< 5 s** on an unloaded box;
   targeted rerun of all 56 family files produces honest pass/fail rows;
   the compile_timeout bucket drops to < 80.
4. Non-goal: raising the 30 s ceiling (hides the problem, pays 30 s × N in
   every CI run forever).

## Verify

- Before/after wall-clock on the 56 family files (record table in this
  file).
- Targeted rerun: family rows leave `compile_timeout`; diff scored normally
  by the baseline gate (no verdict-logic change, no oracle bump).
