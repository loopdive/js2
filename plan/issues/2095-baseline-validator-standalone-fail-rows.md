---
id: 2095
title: "baseline validator: sample the standalone lane and fail rows, not just 50 host pass rows"
status: done
sprint: 62
created: 2026-06-11
updated: 2026-06-16
completed: 2026-06-16
assignee: ttraenkler/dv2
priority: medium
feasibility: easy
reasoning_effort: low
task_type: infrastructure
area: testing
language_feature: n/a
goal: correctness
related: [1897, 1862]
origin: "2026-06-11 analysis program (report 06 §5.1/§6.2); stub 08-C10"
---

# #2095 — one lane, one row class

## Problem

`test262-baseline-validate.yml` spot-checks 50 HOST `pass` rows only. A
rotted standalone baseline silently weakens the #1897 regression floor; a
stale `fail` row that now passes inflates `improvements` and masks one
real regression per PR diff.

## Root cause

Validator samples a single lane and a single row class
(scripts wired per CLAUDE.md "Baseline files" table).

## Plan

Extend the sampler: N standalone `pass` rows + M `fail` rows per lane
(fail rows assert still-failing); deterministic seed unchanged. Include
the #1897 status reconciliation (merged but stale `in-review`).

## Acceptance criteria

- Validator exercises both lanes and both row classes; CI time increase
  bounded (~+1 min)

## Dupe check

#1218 built the pass-row sampler; lane/class coverage unfiled. New
(analysis program).

## Resolution (2026-06-16, dv2)

The validator (`scripts/validate-test262-baseline.ts`) now exercises **both
lanes and both row classes**:

- **Lanes**: HOST (gc) + STANDALONE. The standalone-lane baseline JSONL
  (`test262-standalone-current.jsonl`) is fetched via two new exports on
  `scripts/fetch-baseline-jsonl.mjs` — `ensureStandaloneBaselineJsonl()` /
  `STANDALONE_BASELINE_CACHE_PATH` / `STANDALONE_BASELINE_REMOTE_URL` (the
  fetch+cache core was refactored into a shared lane-parameterised helper;
  `--standalone` CLI flag added). If the standalone baseline is unavailable
  (fresh seed), the validator degrades to host-only with a warning rather than
  failing.
- **Row classes**: N `pass` rows per lane (must STILL pass — the #1218 floor
  check) + M `fail` rows per lane (must STILL fail — a `fail` row that now
  PASSES is flagged as stale-baseline drift that inflates the regression-gate
  `improvements` count and can mask a real regression). Defaults
  `SAMPLE_SIZE=50`, `FAIL_SAMPLE_SIZE=25`; one deterministic PRNG consumed in a
  fixed lane/class order keeps the sample reproducible from the seed.
- Standalone rows compile+run in the standalone lane via a new optional
  `target` parameter threaded into `runTest262File` (`tests/test262-runner.ts`);
  the instantiation path is mode-agnostic (`buildImports` yields an empty
  import object for a standalone binary), so only the `compile()` target
  changed.

### Acceptance criteria — met
- ✅ Validator exercises both lanes and both row classes (verified end-to-end:
  host 32,734 pass / 14,072 fail; standalone 21,184 pass / 11,551 fail sampled
  cleanly).
- ✅ CI-time increase bounded: ~0.76 s/row measured; default ~150 rows
  (50+25 × 2 lanes) ≈ under 2 min total, roughly +1 min over the host-only
  pass-row run.

### Files
- `scripts/fetch-baseline-jsonl.mjs` — standalone lane fetch (URL/path exports,
  `ensureStandaloneBaselineJsonl`, shared `ensureLaneBaselineJsonl` core,
  `--standalone` CLI).
- `scripts/validate-test262-baseline.ts` — dual-lane, dual-row-class sampler
  (`validateLane` / `validateRowClass`).
- `tests/test262-runner.ts` — optional `target` param on `runTest262File`.
- `tests/issue-2095-baseline-validator-lanes.test.ts` — pins the standalone
  fetch exports + the standalone runner target.

### Test Results
- `tests/issue-2095-baseline-validator-lanes.test.ts` — 2/2 pass.
- End-to-end validator smoke (SAMPLE_SIZE=4 FAIL_SAMPLE_SIZE=2, both lanes) —
  12 rows, 0 discrepancies, exit 0.
- `tsc --noEmit` — clean for changed files.
