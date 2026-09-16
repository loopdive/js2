---
id: 6486
title: "test262 CI: run the linked-harness lane on the full corpus as a shadow job with a same-run parity report — prerequisite for making it the default"
status: in-progress
sprint: current
created: 2026-09-16
updated: 2026-09-16
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: infra
area: ci
goal: test262-conformance
depends_on: [3451, 6474, 6477]
related: [3451, 6482, 6483, 5353]
---

# #6486 — linked lane on the full corpus in CI (slice 5 of #3451)

## Why

The project lead wants the linked-harness lane (`TEST262_ORACLE_MODE=linked`,
body compile 15–20× faster, sample wall 156 s vs 414 s) to be the CI default.
#3451's own order is: slice 5 (full-corpus two-lane parity) BEFORE slice 6 (the
authority flip). Today nothing in CI runs the linked lane at all —
`.github/workflows/test262-sharded.yml` never sets `TEST262_ORACLE_MODE` — so
the only parity numbers are hand-run samples (471 rows: linked 361 vs honest
371 after #6474/#6477). A flip on that evidence would trip the regression gate
on an unknown number of rows and would re-seed the published baseline from a
lane that has never been measured whole.

This issue adds the measurement: a non-blocking CI job that runs the linked
lane over the same 52 host chunks as the honest job, plus a same-run parity
report. The flip itself is a follow-up issue gated on this report.

## Implementation Plan (2026-09-16, Fable lane; implementation: Opus)

### P1 — shadow job `test262-linked` in `test262-sharded.yml`

Model it on `test262-native-first` (~L925–1071, the existing non-promoting
shadow lane), not on the required host job:

- `if: github.event_name == 'schedule' || (github.event_name == 'workflow_dispatch' && inputs.linked_lane)`
  — add the `linked_lane` boolean input next to `native_first` (~L73). It must
  NOT run on `merge_group` / `pull_request` and must never be a required check.
- Same chunk matrix as the host job (the 52-chunk list the required
  `test262 js-host shard` matrix uses — read it from the workflow, do not copy
  the native-first 57-list blindly), `TEST262_TARGET: gc`.
- `env`: `TEST262_ORACLE_MODE: linked`, `TEST262_RESULT_PREFIX: test262-linked`,
  `RUN_TIMESTAMP: ${{ github.run_id }}-linked-chunk${{ matrix.chunk }}`, the
  same pool/heap/proposals settings as the host job.
- Steps identical to native-first (checkout, setup, install, build compiler
  bundle + runtime bundle, run shard, completeness validation, upload
  `test262-linked-shard-<n>` with the #3404 retry). The worker builds harness
  providers on demand per fork (`getWorkerHarnessProvider`, memoised per
  prefix); 64 providers × 0.7–2.9 s is acceptable per shard, so no prewarm step
  in this slice. If shard time shows provider builds dominating, use
  `scripts/prewarm-test262-harness-providers.mjs` + a cached artifact the way
  the Temporal provider is downloaded (#5353) — measure first.
- Also stamp the honest job's rows? No — do not touch the required jobs.

### P2 — `merge-linked-report` + parity report

- Job modelled on `merge-native-first-report` (~L1074–1111): download
  `test262-linked-shard-*`, concatenate to
  `linked-results/test262-linked-current.jsonl`, validate completeness across
  all manifests, build the report JSON, upload `test262-linked-baseline-<sha>`.
  It never promotes anything.
- Parity: `scripts/diff-test262.ts` REFUSES a linked lane unconditionally (L1616–
  1625) — that guard stays. Add a separate, clearly non-authoritative tool
  `scripts/test262-linked-parity.mjs <honest.jsonl> <linked.jsonl>` that:
  - joins rows by test path (both lanes of the SAME run: the honest rows come
    from the `test262-js-host-shard-*` artifacts of this run, so the job needs
    `needs: [test262-linked, <host shard job>]` with `if: always()` semantics
    like the merge job, and must skip cleanly when the host shards did not run);
  - reports: common rows, agreement count and %, linked pass/fail/CE/timeout
    totals vs honest, `pass→fail` / `fail→pass` lists, rows stamped
    `oracle_lane: linked-harness-fallback` with their `fallbackReason`
    histogram (a fallback row is a linked-lane miss, count it separately), and
    a message-bucket histogram of the differences (first 80 chars of the
    error) sorted by size;
  - writes `linked-results/test262-linked-parity.json` + a Markdown summary to
    `$GITHUB_STEP_SUMMARY`; exit 0 always (measurement, not a gate).
  - Unit test `tests/issue-6486-linked-parity-report.test.ts` on two tiny
    synthetic JSONL files (agreement, a fallback row, a pass→fail row).
- Wall time: the shard job durations are in the Actions API; in the summary,
  print each lane's total `Run shard` seconds if cheaply available from
  `${{ toJson(needs) }}` — otherwise sum the rows' `compile_ms`/`exec_ms`
  (both lanes) and say which one it is.

### P3 — first full-corpus measurement (Fable lane, after merge)

Dispatch the workflow on main with `linked_lane: true`, record in
`plan/issues/3451-…md`: full-corpus agreement, fallback count and reasons,
top difference buckets (file each as an issue or attribute to #6482/#6483),
and wall time per lane. That record is the input for the flip issue.

### Acceptance

- [ ] `workflow_dispatch` with `linked_lane: true` runs 52 linked shards + the
      parity job green; required checks and the merge-queue path are untouched
      (`docs/ci-policy.md` list unchanged; the new jobs are not in the ruleset).
- [ ] `tests/issue-6486-linked-parity-report.test.ts` green; the parity tool
      exits 0 on differences and refuses nothing.
- [ ] `scripts/diff-test262.ts`'s linked-lane guard unchanged (test in
      `tests/issue-3451-linked-harness-lane.test.ts` still green).
- [ ] Workflow lint: `node scripts/check-workflow-*.mjs` if present, and the
      `quality` gate's workflow checks.
