---
id: 4758
title: "ES2015 destructuring residual compile-timeout cluster"
status: done
created: 2026-08-26
updated: 2026-08-26
completed: 2026-08-26
priority: critical
horizon: m
feasibility: medium
reasoning_effort: max
task_type: conformance
language_feature: destructuring
related: [1719, 4742]
loc-budget-allow:
  - src/runtime.ts
area: codegen, performance, test262
es_edition: es2015
goal: test262-conformance
parent: 4753
assignee: ttraenkler/codex-es6-closeout
files:
  - src/runtime.ts
  - scripts/test262-worker.mjs
  - tests/issue-4758-destructuring-compile-timeouts.test.ts
  - plan/issues/4758-es2015-destructuring-compile-timeouts.md
---

# #4758 — ES2015 destructuring residual compile-timeout cluster

## Problem

The authoritative host run `20260826-180615` at historical head `39f279650`
contains 46 compile-timeout rows. Forty are Test262 destructuring (`/dstr/`)
rows. The exact integration checkpoint for this work is `3fb21eb37` from
`codex/es6-conformance-closeout`; the completed change is handed off to the
successor combined draft PR #5010. A timeout is not a semantic failure
classification and must be reproduced alone before changing compiler behavior.

## Implementation plan

1. Extract the exact 40 host rows from the timestamped JSONL artifact and rerun
   each through a one-path filter with one compiler worker. Record which remain
   compile timeouts and which become pass/fail/compile-error when isolated.
2. Profile at least one confirmed timeout from each syntactic family
   (assignment, formal parameters, class methods, loops, generators). Identify
   the smallest shared compiler phase or generated-source expansion responsible
   for the ten-second boundary.
3. Implement only the confirmed shared compiler fix. Add an issue regression
   that exercises the pathological shape and a nearby non-pathological control;
   do not raise the runner timeout or suppress rows.
4. Rerun all 40 exact host pins and their standalone counterparts, TypeScript
   5/7 checks, formatting, lint, LOC/function budgets, and issue metadata gates.
5. Commit a clean branch tip for integration into the single successor draft
   PR #5010. Record exact denominators and any rows proven to belong to a
   different semantic issue in this file.

## Acceptance

- Zero confirmed compile-timeout rows remain in this 40-row cluster.
- The exact host pins and permanent host/standalone controls pass; the exact
  standalone counterparts all reach their bodies without a timeout, with their
  40 known iterator-semantics failures recorded under related issue #1719.
- No timeout increase, skip, fixture rewrite, or filter exemption is used.

## Baseline extraction and solo confirmation

The source of truth was
`/private/tmp/js2-es6-authoritative-measure3/benchmarks/results/test262-results-20260826-180615.jsonl`.
The exact predicate was `status == compile_timeout`, `compile_ms == 10000`,
`retry_count == 1`, and a file path containing `/dstr/`. It selected 40 unique
rows; every row also had `reached_test == false`, `exec_ms` absent, and
`strict == both`. The ordered path list used for the isolated runs is retained
at `/private/tmp/js2-4758-host-paths.txt`:

```text
test/language/expressions/function/dstr/ary-init-iter-get-err-array-prototype.js
test/language/statements/class/dstr/meth-dflt-ary-init-iter-get-err-array-prototype.js
test/language/statements/let/dstr/ary-init-iter-get-err-array-prototype.js
test/language/expressions/function/dstr/dflt-ary-init-iter-get-err-array-prototype.js
test/language/statements/class/dstr/meth-static-ary-init-iter-get-err-array-prototype.js
test/language/statements/try/dstr/ary-init-iter-get-err-array-prototype.js
test/language/expressions/generators/dstr/ary-init-iter-get-err-array-prototype.js
test/language/statements/class/dstr/meth-static-dflt-ary-init-iter-get-err-array-prototype.js
test/language/statements/variable/dstr/ary-init-iter-get-err-array-prototype.js
test/language/expressions/generators/dstr/dflt-ary-init-iter-get-err-array-prototype.js
test/language/statements/const/dstr/ary-init-iter-get-err-array-prototype.js
test/language/expressions/class/dstr/meth-static-dflt-ary-init-iter-get-err-array-prototype.js
test/language/statements/class/dstr/meth-ary-init-iter-get-err-array-prototype.js
test/language/statements/generators/dstr/dflt-ary-init-iter-get-err-array-prototype.js
test/language/expressions/arrow-function/dstr/ary-init-iter-get-err-array-prototype.js
test/language/statements/for-of/dstr/const-ary-init-iter-get-err-array-prototype.js
test/language/expressions/arrow-function/dstr/dflt-ary-init-iter-get-err-array-prototype.js
test/language/expressions/object/dstr/gen-meth-ary-init-iter-get-err-array-prototype.js
test/language/statements/for-of/dstr/let-ary-init-iter-get-err-array-prototype.js
test/language/expressions/class/dstr/gen-meth-ary-init-iter-get-err-array-prototype.js
test/language/expressions/object/dstr/gen-meth-dflt-ary-init-iter-get-err-array-prototype.js
test/language/statements/for-of/dstr/var-ary-init-iter-get-err-array-prototype.js
test/language/expressions/class/dstr/gen-meth-dflt-ary-init-iter-get-err-array-prototype.js
test/language/expressions/object/dstr/meth-ary-init-iter-get-err-array-prototype.js
test/language/statements/for/dstr/const-ary-init-iter-get-err-array-prototype.js
test/language/expressions/class/dstr/gen-meth-static-ary-init-iter-get-err-array-prototype.js
test/language/expressions/object/dstr/meth-dflt-ary-init-iter-get-err-array-prototype.js
test/language/statements/for/dstr/let-ary-init-iter-get-err-array-prototype.js
test/language/expressions/class/dstr/gen-meth-static-dflt-ary-init-iter-get-err-array-prototype.js
test/language/statements/class/dstr/gen-meth-ary-init-iter-get-err-array-prototype.js
test/language/statements/for/dstr/var-ary-init-iter-get-err-array-prototype.js
test/language/expressions/class/dstr/meth-ary-init-iter-get-err-array-prototype.js
test/language/statements/class/dstr/gen-meth-dflt-ary-init-iter-get-err-array-prototype.js
test/language/statements/function/dstr/ary-init-iter-get-err-array-prototype.js
test/language/expressions/class/dstr/meth-dflt-ary-init-iter-get-err-array-prototype.js
test/language/statements/class/dstr/gen-meth-static-ary-init-iter-get-err-array-prototype.js
test/language/statements/function/dstr/dflt-ary-init-iter-get-err-array-prototype.js
test/language/expressions/class/dstr/meth-static-ary-init-iter-get-err-array-prototype.js
test/language/statements/class/dstr/gen-meth-static-dflt-ary-init-iter-get-err-array-prototype.js
test/language/statements/generators/dstr/ary-init-iter-get-err-array-prototype.js
```

The 40 individual solo launches used one unified worker and an exact one-path
filter. All 40/40 reproduced the baseline `compile_timeout` (`compile_ms=10000`,
`retry_count=1`); none reached the test. This confirms the rows were not merely
queue contention in the full run. The syntactic shape distribution was:
expressions/arrow-function 2, expressions/class 8, expressions/function 2,
expressions/generators 2, expressions/object 4, statements/class 8,
statements/const 1, statements/for 3, statements/for-of 3,
statements/function 2, statements/generators 2, statements/let 1,
statements/try 1, and statements/variable 1. There are no assignment-form
rows in this exact 40-row population; the function/generator rows cover formal
parameters, class rows cover methods, and `for`/`for-of` rows cover loops.
The per-launch JSONL artifacts are
`benchmarks/results/test262-4758-solo-results-20260826-4758-solo-01.jsonl`
through `…-40.jsonl`; one launch artifact contains a duplicate first path, but
the confirmed denominator is the 40 unique paths listed above.

## Root cause

The timeout label was a worker-lifecycle misclassification, not an ES2015
destructuring code-generation timeout. Phase tracing of the exact generated
`let` pin showed compilation, Wasm instantiation, and `__module_init` all
completed. The upstream body first executes
`delete Array.prototype[Symbol.iterator]`. Before the worker could send its
verdict, cleanup destructured each recycle-sentinel tuple. That array
destructuring invoked the deleted iterator and stranded the worker, which the
pool later surfaced as `compile_timeout`.

After that first boundary was removed, result construction exposed the next
iterator-sensitive boundary: `summarizeImports` used `Set` construction and
spread while the iterator was still deleted. After that was made index-based,
the exact caught-`TypeError` control exposed native spread in the host callback
ABI (`callFn(...args)`/method dispatch). Native spread throws before the
compiled callback enters `assert.throws`, so it masked the expected Test262
exception. These are all one shared trigger—test-controlled deletion of a
mutable host intrinsic before worker cleanup and callback dispatch—not separate
destructuring compiler failures.

## Implementation

- `scripts/test262-worker.mjs` now reads recycle-sentinel tuples by index and
  summarizes imports without iterable construction. Built-in restoration also
  reapplies the original `Array.prototype[Symbol.iterator]` descriptor after a
  deletion, preventing an enumerable-value-only restore from dirtying the realm
  canary.
- `src/runtime.ts` adds `_applyWithPrefix`, which builds ABI argument arrays by
  index using captured intrinsics and calls through captured `Reflect.apply`.
  The fixed path covers known-arity and dynamic-arity closure wrappers, JSON
  callable dispatch, and bound closure dispatch—the host callback sites reached
  by this cluster.
- `tests/issue-4758-destructuring-compile-timeouts.test.ts` pins the exact
  generated host test (primary and strict variants), a no-delete host control,
  and destructive/clean standalone worker controls.

No runner timeout, skip, fixture, or test filter was changed as part of the
implementation.

## Regression measurements

### Host lane

The exact 40-row rerun used the same ordered path list, one unified worker,
`TEST262_INCLUDE_PROPOSALS=0`, and a 1,800-second Vitest test ceiling solely to
avoid queue accounting while the single-worker batch ran. The worker's normal
per-job timeout remained 30 seconds. Results:

`benchmarks/results/test262-4758-host-fixed-40-results-20260826-4758-host-fixed-40.jsonl`

| population | rows | pass | fail | compile error | compile timeout | retries |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| exact host pins | 40 | 40 | 0 | 0 | 0 | 0 |

All 40 rows reached the test and report `strict=both`. Measured compile time was
4,378–12,392 ms (sum 314,036 ms); execution was 36–179 ms (sum 3,676 ms).
Every result is `oracle_lane=honest`, `scope=standard`, and `scope_official=true`.
The generated report is
`benchmarks/results/test262-4758-host-fixed-40-report.json`.

### Standalone lane

The exact 40-row standalone rerun used the same ordered path list, one unified
worker, `TEST262_INCLUDE_PROPOSALS=0`, and the pinned QuickJS artifact
`/private/tmp/js2-quickjs-artifact-2e2d7736713beeda`:

`benchmarks/results/test262-4758-standalone-fixed-40-results-20260826-4758-standalone-fixed-40.jsonl`

| population | rows | pass | fail | compile error | compile timeout | retries | reached test |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| exact standalone counterparts | 40 | 0 | 40 | 0 | 0 | 0 | 40 |

All 40 compiled and reached their bodies without a timeout. The 40 failures
are semantic, not lifecycle failures: 39 report `Expected a TypeError to be
thrown but no exception was thrown at all`, and one reports `Expected a
TypeError but got a undefined`. The standalone lowering currently takes a fast
array path that bypasses the live `Array.prototype[Symbol.iterator]` lookup
after deletion, the related standalone destructuring-iterator semantics gap
tracked by #1719. That behavior is outside this host compile-timeout fix and
remains recorded by the exact result artifact.
Standalone compile time was 481–1,492 ms (sum 21,994 ms) and execution was
9–18 ms (sum 422 ms); all rows are `strict=both`, `oracle_lane=honest`,
`scope=standard`, and `scope_official=true`.
The generated report is
`benchmarks/results/test262-4758-standalone-fixed-40-report.json`.

### Controls

The unified-worker no-delete host control passes without a recycle. The exact
host pin passes and requests the expected recycle reason
`prototype sentinel changed: Array.prototype[Symbol.iterator]`. Direct
standalone clean and delete-iterator controls both pass and reach `test()`;
because standalone code is host-free, its destructive control correctly does
not request a Node-worker recycle. The issue regression file preserves these
controls as executable pins.

## Implementation Summary

**What was done:** Confirmed all 40 historical timeout rows independently,
traced the failure past compile/instantiate to iterator-sensitive cleanup,
metadata, and callback seams, and fixed those seams without changing timeout
policy.

**What worked:** Per-file one-worker reproduction plus phase tracing separated a
runner lifecycle failure from compiler code generation. Index-based bookkeeping,
descriptor-preserving restoration, and captured-intrinsic callback application
remove the shared dependency on the test-mutated iterator.

**What did not work:** The initial hypothesis that destructuring itself crossed
the ten-second compiler boundary was false. Removing only cleanup tuple
destructuring revealed metadata `Set`/spread and then callback spread; each was
measured and fixed before the next exact pin rerun.

**Files changed:** `src/runtime.ts`, `scripts/test262-worker.mjs`,
`tests/issue-4758-destructuring-compile-timeouts.test.ts`, and this issue file.

**Handoff:** Standalone measurements and gates are complete. The clean branch
tip is intended for integration into successor combined draft PR #5010. No
individual PR or upstream merge is being opened from this lane.

### Combined-PR CI follow-up

Integration into #5010 initially exceeded the guarded `src/runtime.ts` source
budget by 11 lines. The callback bridge comments and `_applyWithPrefix` argument
descriptor construction were compacted without changing its captured-intrinsic,
iterator-free dispatch behavior. `check:host-import-policy` now passes at
18,275/18,275 lines, and the focused regression file passes 4/4 cases (host and
standalone destructive/control pairs) after rebuilding the worktree-local
compiler and runtime bundles.
