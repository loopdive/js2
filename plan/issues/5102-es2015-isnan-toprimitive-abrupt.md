---
id: 5102
title: "ES2015 standalone isNaN must propagate ToPrimitive abrupt completions"
status: done
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
loc-budget-allow:
  - src/codegen/object-runtime.ts
func-budget-allow:
  - src/codegen/object-runtime.ts::ensureObjectRuntime
files:
  - src/codegen/object-runtime.ts
  - tests/issue-5102-isnan-toprimitive.test.ts
  - plan/issues/5102-es2015-isnan-toprimitive-abrupt.md
---

# #5102 — ES2015 standalone `isNaN` must propagate `ToPrimitive` abrupt completions

## Problem

The global `isNaN` call lowering coerces its argument to an f64 and then tests
the result for NaN. On the standalone path, the native `ToPrimitive` helper did
not probe an object's own `Symbol.toPrimitive` data property, so it fell
through to `valueOf`/`toString` and eventually produced a normal NaN/result
instead of propagating the required `TypeError` or `Test262Error`. The host lane
already passes the target rows, so the fix stays in the standalone native
object runtime and preserves the existing numeric fast path.

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
2. Make the smallest standalone-only change that probes the well-known Symbol
   carrier through the native object's own data-property table, invokes a
   callable method through the existing receiver-aware closure bridge with the
   "number" hint, and throws for non-callable/object or Symbol results.
   Preserve evaluation order, catchability, static numeric fast paths, and
   host-mode lowering. Deliberately leave accessor entries on the existing
   ordinary path so the getter-abrupt row whose host baseline is already red
   remains an excluded control; do not broaden the change to `Number.isNaN`.
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

Implementation is in `src/codegen/object-runtime.ts`. The standalone native
`__to_primitive` helper now probes the well-known Symbol carrier through
`__obj_find`, reads only own data entries, invokes callable values through the
existing receiver-aware `__apply_closure` bridge with the "number" hint, and
throws for non-callable, object, and Symbol results. Accessor entries continue
through the prior ordinary path so the excluded getter-abrupt control remains
unchanged; host-mode codegen is not touched.

Final validation ran after merging and retaining upstream/main at
`698ecb8f1661454037eaed810cb2a6770f6acf7f` (merge commit
`6d407b9c67`) and after pushing implementation commit `8f1d2a06f7`:

- The exact four-row authoritative baseline was host **4/4 pass** and
  standalone **0/4 pass, 4/4 assertion_fail**. The synchronized final tree is
  host **4/4 pass** and standalone **4/4 pass**.
- Two complete repeats produced the same result for every approved row (16/16
  host/standalone executions passed). The diagnostic
  `toprimitive-get-abrupt.js` control remained **fail** in both modes on both
  repeats, as required by its host-red baseline and this lane's bounded scope.
- With `JS2WASM_FUSED_TONUMBER=0` and `JS2WASM_SMI_FASTPATH=0`, the standalone
  four-row cohort remained **4/4 pass**.
- Focused `tests/issue-5102-isnan-toprimitive.test.ts`: **10/10 passed**,
  covering the exact host and standalone rows, numeric/string/nullish/
  ordinary-object controls, a host-free standalone module, and the excluded
  getter control.
- The normal pre-push gates passed on `8f1d2a06f7`: typecheck, lint, Prettier,
  oracle/coercion-site ratchets, numeric-local IR parity (18/18), and issue
  integrity, with `TEST262_WORKERS=2`. No full 11,704-row census was run.

The plan checkpoint is `df96e0d86b`; implementation checkpoint is
`8f1d2a06f7`. After that validation, upstream/main advanced to
`eafd6700ac54fdf2b89a6b77eb0560b3b475fdb9` and was merged in
`ed387a0a18` before the final handoff.

The focused suite now guards only its eight corpus-backed exact host/standalone
cases with `existsSync(test262/harness/assert.js)`. With the corpus present,
it ran **10/10 passed** after the `eafd6700ac` merge. In a no-corpus
temporary root `/private/tmp/js2-5102-no-corpus.7uw5uw`, it ran **2 passed /
8 skipped**: both self-contained controls remained mandatory and green, while
only the eight Test262-dependent cases skipped. The direct final exact run on
the synchronized tree was **4/4 host and 4/4 standalone pass**.

The final evidence commit and upstream synchronization commit will be pushed
before opening the single compliant PR; no GitHub issue is created or linked.
