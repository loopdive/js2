---
id: 5102
title: "ES2015 standalone isNaN must propagate ToPrimitive abrupt completions"
status: in-progress
sprint: current
created: 2026-08-28
updated: 2026-08-28
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
es_edition: es6
language_feature: isNaN, ToPrimitive, Symbol.toPrimitive
goal: standalone-mode
assignee: "ttraenkler/codex/es2015-next-lane-c"
files:
  - src/codegen/expressions/call-identifier.ts
  - tests/issue-5102-isnan-toprimitive.test.ts
  - plan/issues/5102-es2015-isnan-toprimitive-abrupt.md
---

# #5102 — ES2015 standalone `isNaN` must propagate `ToPrimitive` abrupt completions

## Problem

The global `isNaN` call lowering coerces its argument to an f64 and then tests
the result for NaN. On the standalone path, an object with an exotic
`Symbol.toPrimitive` is represented by a lossy numeric placeholder before the
required `ToPrimitive` call can throw. That turns required `TypeError` or
`Test262Error` completions into ordinary boolean results. The host lane already
passes the target rows, so the fix must stay standalone-only at the narrowest
global-call/coercion site and preserve the existing numeric fast path.

## Exact cohort and authoritative baseline (2026-08-27)

The cohort is the ES2015 edition (`website/public/benchmarks/results/test262-file-editions.json`
maps these files to `ES2015`) and consists of exactly these four rows:

- `test/built-ins/isNaN/toprimitive-call-abrupt.js`
- `test/built-ins/isNaN/toprimitive-not-callable-throws.js`
- `test/built-ins/isNaN/toprimitive-result-is-object-throws.js`
- `test/built-ins/isNaN/toprimitive-result-is-symbol-throws.js`

The authoritative host and standalone JSONL snapshots were fetched from
`loopdive/js2wasm-baselines` on 2026-08-28. Both carry oracle version 13 and
48,735 rows; the promoted source summary identifies baseline SHA
`857b343f344d566f3f382168a8538dd8dca26f2c`. The host lane is **4/4 pass**.
The standalone lane is **0/4 pass, 4/4 fail**; every failure is an
`assertion_fail` caused by the expected abrupt completion being replaced by a
normal result. The neighbouring getter-abrupt row
`toprimitive-get-abrupt.js` is deliberately not in the cohort because its
authoritative host row also fails; it remains a diagnostic control, not an
acceptance row.

For context only, the same authoritative ES2015 edition contains 11,704 rows;
the full edition snapshot is 9,580 standalone passes and 9,606 host passes.
No full-corpus census is part of this issue.

## Implementation plan

1. Reproduce the four rows through the maintained Test262 runner in this
   worktree and inspect the emitted standalone coercion path. Confirm that a
   positive numeric/string control still reaches the existing `f64.ne` NaN
   test and that the host lane remains green.
2. Make the smallest standalone-only change that keeps object arguments on the
   throwing `ToPrimitive`/`ToNumber` path instead of substituting NaN. Preserve
   evaluation order, catchability, static numeric fast paths, and host-mode
   lowering. Do not broaden the change to `Number.isNaN`, unrelated coercions,
   or the getter-abrupt row whose host baseline is already red.
3. Add a focused compiler regression test covering all four target shapes plus
   numeric, string, nullish, and ordinary-object controls. Re-run the exact
   Test262 cohort in host and standalone modes and record per-row statuses.
4. Run the focused Vitest test, TypeScript/lint/format checks, and the normal
   scoped pre-push gates with `TEST262_WORKERS<=2`. Record final counts,
   artifacts, commit SHAs, and the upstream PR handoff below.

## Acceptance

- The four exact rows are **4/4 pass** in both host and standalone lanes.
- Standalone emits no host imports for the target rows and reports zero
  failures, compile errors, or compile timeouts for the cohort.
- The expected `Test262Error` and `TypeError` completions remain catchable and
  occur in the specified order; numeric, string, nullish, and ordinary-object
  controls retain their existing `isNaN` results.
- The neighbouring host-red getter-abrupt row remains unchanged, and no
  unrelated `isFinite`/`Number.isNaN` or global-function metadata behavior
  regresses.
- One ready upstream PR is opened from `ttraenkler/js2` against
  `loopdive/js2:main` with the exact `## Description` and `## CLA` sections and
  a checked CLA statement. The issue file remains the tracking record; no
  GitHub issue is created.

## Evidence and handoff

Implementation and validation evidence will be appended here before the PR is
handed off. Until then this issue intentionally records only the measured
baseline and bounded plan above.
