---
id: 779
title: "Assert failures: tests compile and run but produce wrong values (8,674 tests)"
horizon: xl
status: ready
created: 2026-03-23
updated: 2026-05-28
priority: critical
feasibility: hard
reasoning_effort: max
goal: spec-completeness
sprint: current
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

## 2026-05-28 refresh — issue-1318-v2 (senior-dev investigation)

Authoritative baseline `.test262-cache/test262-current.jsonl`
(48,141 rows · timestamp `25.5.2026, 14:19:58` · standard scope):
**pass=28,967 fail=12,043 compile_error=1,060 compile_timeout=3**.
The umbrella's "8,674 assertion_fail" figure is stale — the
baseline JSONL no longer carries the `reason` field, so all FAIL
rows are bucketed together (compile-failed-runtime tests are now
counted with assertion-fails; the historical decomposition into
`returned 2/3/4/5/…` is no longer reproducible from this file
alone). Treat the current 12,043 FAIL as the umbrella's working
set; the 8,674 figure stays as a 2026-04-07 historical anchor.

### Current FAIL bucket — top 3-level path prefixes

| Prefix | FAIL | Routed to (status) |
|---|---:|---|
| `built-ins/Array/prototype` | 1,424 | #1130 (escalated, needs spec — task #63) + #1461 (array-like receivers) + #1601 (done) |
| `language/statements/class` | 1,085 | #1364b + #1451 + #1456 + #1543/#1544 (done residuals) |
| `language/expressions/class` | 986 | same as above |
| `built-ins/Object/defineProperty` | 624 | **#1629** (escalated 2026-05-27, needs architect — investigation in `1629-…md`) |
| `language/statements/for-of` | 364 | #1396 + #1454 + #1468 + #1347 (done) |
| `language/statements/for-await-of` | 299 | #1347b (in_progress) |
| `language/expressions/object` | 296 | #779d (in_progress, task #107) |
| `built-ins/String/prototype` | 296 | mixed — see decomposition below |
| `built-ins/Object/defineProperties` | 295 | inherits #1629 fix |
| `built-ins/TypedArray/prototype` | 179 | shares #1130 accessor-observing pattern |
| `language/expressions/assignment` | 179 | #1431 (in-review) |
| `built-ins/Iterator/prototype` | 177 | #1340 + #1464 (active) — Iterator Helpers proposal |
| `built-ins/RegExp/prototype` | 165 | #1329 + #1330 + #1331 (done) + #1332 (done) |
| `built-ins/Function/prototype` | 158 | #1632a (just spec'd, dev task #183) + #1596 (apply/call, task #175) |
| `built-ins/Object/create` | 145 | #1648 (in_progress, task #173) + #1334 (done) + #1631 (done) |

### Array.prototype callback-family (~790 fails) — already routed

`reduce` 135, `reduceRight` 140, `filter` 120, `map` 104, `every`
102, `some` 96, `forEach` 93. Sampled tests all match the ES5
`15.4.4.{16,17,18,19,20,21,22}-{4,5,7,8,9}-{b,c}-{i,ii,iii}-*`
pattern. Three root causes, all already covered:
- `Object.defineProperty` on `Array.prototype` to install accessors → **#1629**
- `Array.prototype.METHOD.call(arrayLike)` with non-Array receiver → **#1461**
- inherited getter/setter observation during iteration → **#1130**
**No new sub-issue needed** — these decompose into existing
escalated/spec-needed sub-issues.

### String.prototype (296) — decomposition

| Method | FAIL | Sub-issue |
|---|---:|---|
| split | 26 | #1331 (done) — residuals |
| replace | 22 | #1329 (escalated, task #141) |
| replaceAll | 21 | #1329 |
| match | 20 | #1329 |
| substring | 17 | **unrouted** — likely #1130 accessor-observing or numeric-coercion edge |
| search | 16 | #1330 (in_progress, task #149) |
| indexOf | 16 | **unrouted** — small, defer |
| slice | 14 | **unrouted** — small, defer |
| toUpperCase / toLowerCase / toLocale{Upper,Lower}Case | 49 | #1604 (done codegen) — residuals are spec-correctness |
| matchAll | 11 | #1329 |
| rest (charAt, concat, lastIndexOf, includes, trim, …) | ~84 | residual; defer until accessor / coercion fixes land |

Substring/indexOf/slice (~47 combined) are the only mildly
worth-it unrouted slice; suggested follow-up sub-issue **only**
if a developer is otherwise idle. Not creating one now.

### Object.prototype (79) — decomposition

`toString` 22 → tied to `#1364b` prototype-chain (per #779b
investigation, task #69 ESCALATED). Rest is `propertyIsEnumerable`
9, `hasOwnProperty` 8, `__proto__` 7, `valueOf` 5,
`__defineGetter__` / `__defineSetter__` 10 — all small, share
the descriptor-model / sidecar root cause already tracked by
**#1629** and **#1631** (done).

### Function.prototype (158) — decomposition

- `bind` 66 → **#1632a** (spec finalized 2026-05-28; dev task #183)
- `apply` 36 → **#1596** (in_progress, task #175)
- `call` 33 → **#1596**
- `toString` 8 → **#1632b** (carved, task #165 — routed to architect joint with #1630/#1631)
- `Symbol.hasInstance` 8 → unrouted residual, low priority
- pre-ES2015 `caller`/`arguments` 3 → spec-deprecated, defer

### RegExp.prototype (165) — decomposition

- `Symbol.replace` 40 → #1329
- `exec` 25 → #1332 (done) — residual
- `Symbol.match` 20 → #1329
- `Symbol.split` 17 → #1331 (done) — residual
- `test` 14 → unrouted small
- `Symbol.search` 12 → #1330 (in_progress)
- `Symbol.matchAll` 11 → #1329
- prototype getters (`flags`, `ignoreCase`, etc.) ~14 → unrouted small

### TypedArray.prototype (179)

Broad spread across `set` (15), `map` (9), `slice` (8), `sort`
(8), `byteLength` (8), `includes` (7), `length` (7), and ~20
other methods at 5–6 fails each. The pattern mirrors
Array.prototype — likely the same root causes (`#1130`
accessor-observing + receiver-coercion). No new sub-issue;
defer until #1130 / #1461 architect specs land — TypedArray
fixes likely come "for free" from those.

### class/dstr + class/elements (~1,500 combined) — already routed

`class/dstr (stmt)` 424 + `class/dstr (expr)` 410 + `class/elements
(stmt)` 378 + `class/elements (expr)` 339 + `class/dstr`-related
expression forms. Covered by #1364b, #1451, #1456, #1364 (done),
#1543/#1544 (done), #779a (done), #1543/#1450 family. No new
carve.

### Conclusion of 2026-05-28 investigation

**No new sub-issues warranted.** Every non-trivial fail cluster
already has either:
- an open implementation task (e.g. #1632a/dev-task-183, #1596,
  #1329, #1330, #1347b, #1648),
- an escalated-needs-spec architect entry (#1130, #1629,
  #1594, #1320, #1644 Slice B), or
- a completed fix landing residuals that will tail off as
  upstream specs land (#1331, #1332, #1604, #1631).

The umbrella is doing its job — it surfaced the buckets, the
buckets have homes. The two `[ESCALATED-NEEDS-SPEC]` items
that gate the largest residuals are:

1. **#1629 Object.defineProperty attribute fidelity** (624 +
   295 defineProperties + downstream Array/Object.prototype
   propagation ≈ 1,200+ tests). Investigation 2026-05-27
   already documents 3 sub-issues (#1629a/b/c) and recommends
   carve before any dev claim. **Next action**: architect
   spec for #1629a (dynamic-descriptor materialization).

2. **#1130 Array methods observing accessor getters** (≈790
   Array.prototype callback fails + ≈179 TypedArray + likely
   parts of #1461). Already escalated (task #63), findings
   doc'd in issue file, branch `issue-1130-array-getter`
   has WIP commit b00babe27. **Next action**: architect
   spec to define the accessor-protocol path.

Umbrella stays open as a tracker. Acceptance unchanged:
close when standard-scope FAIL drops below 2,000 AND
escalated sub-issues have spec'd plans.
