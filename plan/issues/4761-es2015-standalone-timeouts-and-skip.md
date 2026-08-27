---
id: 4761
title: "ES2015 standalone Test262 compile timeouts and compiler-hang skip"
status: in_progress
created: 2026-08-26
updated: 2026-08-27
priority: critical
horizon: s
feasibility: medium
reasoning_effort: max
task_type: conformance
area: typedarray, control-flow, test262
es_edition: es2015
goal: test262-conformance
parent: 4753
assignee: ttraenkler/codex-es6-closeout
files:
  - src
  - scripts
  - tests
  - plan/issues/4761-es2015-standalone-timeouts-and-skip.md
---

# #4761 — ES2015 standalone Test262 timeouts and skip

## Problem

The complete standalone run `20260826-194014` at exact code head `0bed210fd`
contains two compile timeouts and one compiler-hang skip in the 11,704-row
ES2015 bucket:

- `test/built-ins/TypedArray/prototype/byteOffset/detached-buffer.js` —
  `compile_timeout`, 10 seconds.
- `test/built-ins/TypedArray/prototype/Symbol.toStringTag/detached-buffer.js` —
  `compile_timeout`, 10 seconds.
- `test/language/statements/for-of/body-put-error.js` — `skip`, listed as a
  compiler hang.

The authoritative JSONL is
`/private/tmp/js2-es6-authoritative-measure4/benchmarks/results/test262-standalone-results-20260826-194014.jsonl`.
No timeout increase, skip-list expansion, or reclassification can close these
rows.

## Bounded probe handoff (2026-08-26)

Each probe used a fresh host or standalone process, the harness-flip controls
(must-pass and must-fail), a 15-second per-file ceiling, and a 45-second outer
process alarm. The controls reported both directions in every run.

- `byteOffset/detached-buffer.js`: host `1/1 fail` in
  `.tmp/4761-byteOffset-host-checkpoint.jsonl`; standalone `1/1 fail` in
  `.tmp/4761-byteOffset-standalone-checkpoint.jsonl`. Both rows report
  `sample.byteOffset === 8` where the test requires `0` (the earlier standalone
  attempt was a bounded `RangeError`, not a pass).
- `for-of/body-put-error.js`: with the exemption temporarily bypassed, host
  `1/1 pass` in `.tmp/4761-forof-host-resume.jsonl` and standalone `1/1 pass`
  in `.tmp/4761-forof-standalone-resume.jsonl`. This is not #3122 acceptance:
  the focused setter-throw and IteratorClose assertions have not been proven,
  so the `HANGING_TESTS` entry is restored and #3122 remains in progress.
- `Symbol.toStringTag/detached-buffer.js`: the solo disposition is `1/1 pass`
  in both lanes (`.tmp/4761-host-after.jsonl` and
  `.tmp/4761-standalone-after.jsonl`); no fix obligation remains for that row.

The attempted source changes did not flip the owned byteOffset row and were
rolled back rather than retained as an unproven shared workaround. The issue
therefore stays `in_progress`; the next implementation handoff is the dynamic
TypedArray buffer/view identity path, not a timeout or denominator change.

The authoritative standalone denominator remains `11,704` rows:
`8,402` pass, `2,728` fail, `571` compile errors, `2` compile timeouts, and
`1` skip in run `20260826-194014`.

## Implementation plan

1. Run each exact path as a fresh solo process in host and standalone modes,
   with pass/fail harness controls, and record wall time and final disposition.
2. For the two detached-buffer rows, reduce the shared compiler/runtime path
   and determine whether the hang is compilation, adapter initialization, or
   execution misclassified by the runner.
3. For `body-put-error.js`, remove the historical hanging-test exemption only
   after reproducing the compiler path under a bounded process and reducing the
   responsible control-flow pattern.
4. Implement the narrow shared fixes with focused regressions and adjacent
   controls. Do not raise timeouts or add filters, fixture rewrites, or skips.
5. Rerun all three exact rows in both lanes, run TypeScript 5/7, formatting,
   lint, budgets, ratchets, and issue gates, then commit and push a clean branch
   for integration into the sole draft PR #5010.

## Acceptance

- All three rows have fresh solo host and standalone dispositions.
- Each row passes in both maintained lanes without an exemption or timeout
  increase.
- Focused regressions and controls pass, and repository gates remain green.
- The issue records exact artifacts, denominators, and any unrelated handoff.

## 2026-08-27 clean-upstream resume checkpoint

This checkpoint starts from `upstream/main` at `fcded6410`. The historical
full-run labels are controls, not current dispositions; all acceptance evidence
must come from fresh maintained-runner processes.

1. Rerun the three exact owned paths in standalone mode with at most two
   workers, then rerun them solo with bounded outer processes. Record whether
   each reaches compilation, instantiation, and execution.
2. Treat the detached `byteOffset` semantic mismatch as the primary source
   task. Reduce buffer detachment, view identity, and byte-offset observation
   separately before modifying TypedArray lowering or runtime state.
3. Treat `Symbol.toStringTag/detached-buffer.js` as a must-pass regression
   control unless the fresh run disproves its prior solo pass.
4. Remove the `body-put-error.js` exemption only after focused coverage proves
   both setter abrupt propagation and IteratorClose behavior under a bounded
   standalone run. A runner-only unskip is not a completed semantic fix.
5. Run the exact three-row maintained official-scope slice, focused tests, and
   all pre-push gates. The checkpoint is complete only at 3/3 with zero fail,
   compile error, timeout, or skip; otherwise record exact residuals and hand
   off in a draft PR.

## 2026-08-27 maintained-runner checkpoint (unfinished)

The required exact maintained standalone slice was run from clean upstream
head `fcded6410` with `--official-scope-only`, `COMPILER_POOL_SIZE=2`, and the
three-file `TEST262_PATH_FILTER`. Run `20260827-050810` wrote these artifacts:

- JSONL: `benchmarks/results/test262-standalone-results-20260827-050810.jsonl`
- report: `benchmarks/results/test262-standalone-report-20260827-050810.json`
- denominator: exactly 3 official standard rows
- summary: `1 pass`, `0 fail`, `0 compile_error`, `1 compile_timeout`, `1 skip`

The exact rows were:

- `test/built-ins/TypedArray/prototype/Symbol.toStringTag/detached-buffer.js`:
  `pass`, reached test, `compile_ms=47158`, `exec_ms=2941` (must-pass
  control).
- `test/built-ins/TypedArray/prototype/byteOffset/detached-buffer.js`:
  `compile_timeout`, `timeout (10s)`, `retried=true`, `retry_count=1`, and
  `reached_test=false`.
- `test/language/statements/for-of/body-put-error.js`: `skip`,
  `compiler hang (see HANGING_TESTS)`, and `reached_test=false`.

A host maintained control with the same exact filter completed as run
`20260827-051421` (target `gc`). Its artifacts are
`benchmarks/results/test262-results-20260827-051421.jsonl` and
`benchmarks/results/test262-report-20260827-051421.json`; the exact summary is
`1 pass`, `1 fail`, `0 compile_error`, `0 compile_timeout`, and `1 skip`.
The Symbol control passed (`compile_ms=3287`, `exec_ms=71`), byteOffset reached
the assertion and failed with `Expected SameValue(«8», «0»)`, and
body-put-error remained the `HANGING_TESTS` skip. This host result is a
complete control disposition, but it is not the acceptance lane.

Source inspection confirms the remaining byteOffset work is semantic and
dynamic-view specific, not a timeout-policy problem: the test constructs via
the dynamic `testWithTypedArrayConstructors` path, while the static typed-array
accessor lowering handles statically known view layouts and the dynamic view
representation stores its byte offset separately. The earlier bounded probes
remain the direct semantic evidence: after detachment, host and standalone
both reached the assertion and observed `sample.byteOffset === 8` where the
specification test requires `0`. The next implementer should trace the
dynamic view property read through detachment state and return zero for a
detached view, with a focused detached/in-bounds control; do not raise the
compile timeout or reclassify the row.

The `body-put-error.js` entry remains in `HANGING_TESTS`. A temporary bypass
once produced `pass` in both lanes, but setter-abrupt propagation and
IteratorClose have not been proven under the maintained standalone path, so
removing the exemption would be an unsupported runner-only unskip. Keep the
exemption until focused proof covers both behaviors.

This checkpoint is unfinished: the exact maintained standalone slice is not
3/3 and still has one compile timeout plus one skip. No source, timeout, or
skip-list changes were retained. The timestamped artifacts above are the
authoritative handoff evidence; generated report files and symlinks are
restored/removed before handoff.
