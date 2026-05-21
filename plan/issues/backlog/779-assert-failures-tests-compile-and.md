---
id: 779
title: "Assert failures: tests compile and run but produce wrong values (8,674 tests)"
status: ready
created: 2026-03-23
updated: 2026-04-09
priority: critical
feasibility: hard
reasoning_effort: max
goal: spec-completeness
test262_fail: 8674
sprint_role: analysis-only
---
# #779 -- Assert failures: tests compile and run but produce wrong values (8,674 tests)

## Problem

Tests fail with `returned 2` (first assertion failed) or other non-1 return
values. The code compiles, instantiates, and runs without crashing, but
produces incorrect values or fails the expected assertion semantics.

This remains the largest broad runtime-semantics umbrella, but it is now much
better split than when this issue was first written. Several former major
sub-buckets have already been broken out or completed.

### History
- 2026-03-25: 8,700 -> 7,096 after fixes #780-#787
- 2026-03-28 (initial): 10,988 (count increase from unblocking class/elements, String/prototype, directive-prologue, future-reserved-words tests that were previously skipped)
- 2026-03-28 (final): 10,099 (full 48K test run)
- 2026-04-07 official full recheck (`20260407-111308`): **8,674** assertion-failure-style `returned N` fails

### Current return code distribution (`20260407-111308`)

| Code | Count | Meaning |
|------|-------|---------|
| returned 2 | 6,502 | First assertion failed |
| returned 3 | 1,122 | Second assertion failed (first passed) |
| returned 5 | 399 | Fourth assertion failed |
| returned 4 | 287 | Third assertion failed |
| returned 6 | 98 | Fifth assertion failed |
| returned 10 | 72 | Ninth assertion failed |
| returned 7 | 71 | Sixth assertion failed |
| returned 0 | 25 | Early return / special control-flow cases |
| other (8+) | 98 | Later assertion failures |

### Current breakdown by category (`returned N` umbrella)

| Category | Count | Sub-issues |
|----------|-------|------------|
| language/statements | 2,150 | class elements / destructuring / for-of / for-await-of remain large |
| language/expressions | 2,023 | class elements / destructuring / assignment semantics remain large |
| built-ins/Object | 1,422 | defineProperty / defineProperties / Object.create still dominate |
| built-ins/Array | 692 | prototype and iteration semantics |
| built-ins/RegExp | 357 | host-wrapper and protocol semantics |
| annexB/language | 275 | eval/function Annex B semantics |
| built-ins/Date | 154 | |
| built-ins/Proxy | 141 | |
| built-ins/String | 135 | |
| language/arguments-object | 132 | trailing-comma / mapped-arguments behavior |
| built-ins/Iterator | 112 | |
| built-ins/Function | 101 | |
| built-ins/Number | 89 | |
| built-ins/Reflect | 73 | |
| language/eval-code | 70 | |
| built-ins/JSON | 57 | |
| language/function-code | 55 | |
| built-ins/ArrayBuffer | 55 | |
| language/module-code | 44 | |

### Highest-current residual families by path

| Path prefix | Count | Likely root cause |
|------------|-------|-------------------|
| `test/built-ins/Object/defineProperty` | 609 | descriptor validation / sidecar storage / boxing semantics |
| `test/language/statements/class/elements` | 395 | class element naming / static/private / computed member semantics |
| `test/language/expressions/class/elements` | 335 | class element naming / computed member semantics |
| `test/built-ins/Object/defineProperties` | 324 | descriptor validation / bulk-define behavior |
| `test/language/expressions/class/dstr` | 302 | class + destructuring interactions |
| `test/language/statements/class/dstr` | 289 | class + destructuring interactions |
| `test/language/statements/for-of/dstr` | 270 | iterator/destructuring runtime semantics |
| `test/built-ins/Object/create` | 222 | property model / prototype defaults |
| `test/language/statements/for-await-of` | 192 | async iteration semantics |
| `test/built-ins/RegExp` | 167 | host-wrapper/protocol gaps |

### Why the old issue text is now stale

Several major March buckets have already been split out or closed:

- [#797](../done/797.md) property descriptor subsystem — done
- [#847](../done/847.md) for-await-of / for-of destructuring wrong values — done
- [#848](../done/848.md) class computed property/accessor correctness — done
- [#849](../done/849.md) mapped arguments sync — done

This umbrella should now be read as “what still remains after those splits,” not
as a literal current decomposition of all wrong-value failures.

## Root causes (estimated breakdown)

| Root cause | Est. tests | Compiler file |
|-----------|-----------|---------------|
| Object descriptor / property-model residuals | ~1,200-1,500 | `src/codegen/expressions.ts`, `src/codegen/index.ts`, property sidecar paths |
| Class elements + computed/private/static semantics | ~700-900 | `src/codegen/index.ts`, class element lowering |
| Destructuring runtime semantics still not covered by narrower issues | ~700-900 | `src/codegen/statements.ts`, `src/codegen/expressions.ts` |
| `assert.throws`/wrong-exception semantics that are broader than #846 | ~1,500-2,000 | `src/codegen/expressions.ts`, `src/codegen/statements.ts` |
| RegExp host-wrapper / protocol semantics | ~300-400 | runtime host wrappers / RegExp built-ins |
| Annex B eval/function semantics | ~150-250 | eval lowering / Annex B runtime behavior |

## Sub-issues

- #739 Object.defineProperty correctness (262 fail)
- #786 Multi-assertion failures (returned N > 2)
- #846 assert.throws not thrown for invalid built-in arguments (2,799 fail)
- #1002 RegExp js-host mode completion
- #1431 assignment-pattern destructuring completion (in-review)
- #1432 parameter-list rest/destructuring iterator semantics (done)
- #1450 NamedEvaluation in destructuring defaults (in-review)
- #1451 class/object-literal method param destructuring (in-review)
- #1454 iterator-protocol error propagation / IteratorClose (in-review)
- #1455 subclassing builtins instanceof (done)
- #1460 Object.defineProperty descriptor fidelity (in-review)
- #1461 Array.prototype.* on array-like receivers (in-review)
- #1462 Object.getOwnPropertyDescriptor / Object.create (in-review)
- #1518 Annex B sloppy function-in-block hoisting (in-review)
- **#1550 dstr-binding `init-skipped`: default initializer evaluated when value is non-undefined** (~252 fail)
- **#1551 SuperCall: argument evaluation order, spread getter side-effects, uninitialized-`this` PutValue** (~64 fail)
- **#1552 catch parameter destructuring (`try/dstr`): residuals after #1450/#1454** (~58 fail)
- **#1553 let/const/var declaration destructuring residuals (`statements/{let,const,variable}/dstr`)** (~93 fail)

## Completed split-outs

- #797 property descriptor subsystem
- #847 for-await-of / for-of destructuring wrong values
- #848 class computed property and accessor correctness
- #849 mapped arguments object sync

## 2026-05-20 fresh sub-cluster analysis (assertion_fail rows only)

Total `assertion_fail` rows in current baseline: **9,231**. Top sub-clusters
NOT yet routed to an active sub-issue, ranked by likely test-unlock:

| Sub-cluster | Tests | Routed to |
| --- | --- | --- |
| `Array.prototype.*` array-like receivers | 947 | #1461 |
| `class/dstr` method param destructure (gen/async-gen/private) | 727 | #1451 |
| `class/elements` descriptor / private fields | 679 | #1364 (done), #1456 |
| `Object/defineProperty` + `defineProperties` | 846 | #1460 |
| `for-of/dstr` async-iter + iterator-close | 252 | #1396, #1454, #1468 |
| **dstr `init-skipped` (default evaluated even when value defined)** | **252** | **#1550 (new)** |
| `expressions/assignment/dstr` residuals | 138 | #1431 (mostly), #1454 |
| `Object/create` | 118 | #1462 |
| `eval-code/direct` Annex B | 104 | #1518 |
| **`statements/{let,const,variable}/dstr` declaration form** | **93** | **#1553 (new)** |
| `Array.prototype/{filter,every,some,forEach,map}` (subset of #1461) | ≈460 | #1461 |
| **`expressions/super` arg-eval / spread / uninitialized-this** | **64** | **#1551 (new)** |
| **`statements/try/dstr` catch destructuring** | **58** | **#1552 (new)** |
| `expressions/object/method-definition` (non-dstr name/eval) | 40 | (residual, low priority) |
| `expressions/yield` iterator-result-value semantics | 31 | (residual) |
| `statements/switch` completion semantics | 25 | (residual) |

The four new sub-issues (#1550–#1553) together cover ~467 still-failing tests
that the prior sprint-52 splits do not address.

## Acceptance criteria

- keep this as an umbrella / analysis issue, not a direct implementation target
- refresh counts and active sub-issues against the latest official-scope run
- ensure completed split-outs are removed from the active sub-issue list
- keep the residual active list focused on still-open root-cause buckets

## Implementation Plan

(Author: architect, 2026-05-21. #779 is an umbrella — no direct
code; the work is in sub-issues. Per existing notes, this is
`sprint_role: analysis-only`.)

### No direct entry point

#779 has no code to write. Sub-issues drive the work. Frontmatter
flag `sprint_role: analysis-only` is correctly set.

### Dispatch order (after sub-issues that already have plans)

1. **#1550** (init-skipped) — largest single new cluster (~252).
   Mechanical fix in `destructureParamArray` / let-const-var dstr.
2. **#1551** (super call evaluation order) — ~64; SuperCall
   lowering surgery.
3. **#1552** catch dstr — overlaps with the #1552 in this repo
   (tagged unions). Rename one. The 779-listed "#1552" is "catch
   parameter destructuring"; the global #1552 in backlog/ is
   "tagged-union value rep". **Action**: rename the 779-side
   sub-issue to #1554 to avoid collision.
3. **#1553** let/const/var dstr residuals — overlaps with #1555.
4. Existing in-review sub-issues should be merged before opening
   new ones to clear the queue.

### Sub-issues needing architect specs

The following sub-issues are currently `feasibility: hard` or
`reasoning_effort: high` and lack their own Implementation Plans:

- #1461 — Array.prototype.* on array-like receivers (~947) — see
  also #1130 plan (shared [[Get]] helper).
- #1460 — Object.defineProperty descriptor fidelity (~846) — see
  #739 plan; overlap.
- #1518 — Annex B sloppy function-in-block hoisting — needs spec.
- #1550 — dstr init-skipped — needs spec.
- #1551 — SuperCall — needs spec.
- #1553 — let/const/var dstr residuals — needs spec.

Recommendation: dispatch architect to each in turn after #779/#820
umbrella triage.

### Acceptance

When umbrella drops below 2,000 official assertion_fail rows AND
all called-out sub-issues have explicit Implementation Plans,
close umbrella and convert to a tracker.
