---
id: 1853
title: "Track a separate hard-error (compiler-crash / malformed-Wasm) stability bucket on the conformance dashboard, distinct from unsupported-feature"
status: done
sprint: 63
created: 2026-06-04
updated: 2026-06-16
completed: 2026-06-16
assignee: ttraenkler/tld-2108
priority: high
feasibility: easy
reasoning_effort: medium
task_type: infrastructure
area: testing
language_feature: n/a
goal: observability
related: [1376, 1850]
---
# #1853 — Separate hard-error stability bucket on the conformance dashboard

**Source:** [`docs/architecture/compiler-design-lessons.md`](../../docs/architecture/compiler-design-lessons.md) — recommendation **R6** (P1).

## Problem

Coverage and stability are different signals that are easy to conflate.
"We don't support `Proxy` yet" is a roadmap fact; "we crashed / emitted
invalid Wasm compiling a `for` loop" is a **bug**. A dashboard that merges
"compiler error / malformed output" into the same not-passing total as
"unsupported feature" cannot see a stability regression hiding behind an
expected gap. The fallback budget already buckets *IR demotions* by reason;
the same discipline should apply to *conformance outcomes*.

## Recommendation

Keep a first-class **hard-error bucket** ("compiler error" / "malformed
Wasm" / verifier-failure-on-claimed-function from #1850) on the test262 /
conformance dashboard, watched as a *stability* metric and **gated**,
separately from the informational "unsupported feature" count. Target:
keep the hard-error bucket near-zero; treat any growth as a
release-blocking regression, not a coverage statistic.

## Acceptance criteria

- [ ] Conformance reporting distinguishes `compiler_error` / `malformed_wasm`
      (and verifier-failure) outcomes from `unsupported_feature` outcomes.
- [ ] The hard-error bucket is surfaced on the dashboard and has a CI gate
      that fails on growth (mirrors the IR fallback-budget ratchet, #1376).
- [ ] A verifier failure on a claimed function (#1850) routes into this
      bucket rather than being silently swallowed.
- [ ] Baseline recorded; current hard-error count documented as the ceiling.

## Implementation (2026-06-16)

A hard error is a compiler BUG distinct from an expected coverage gap. The
strongest unambiguous signal: the compiler reported `result.success` for a
binary the Wasm engine then **rejected at instantiate** (`CompileError` /
`LinkError`), or compile+instantiate succeeded but the required `test` export
is missing. These are tagged `hard_error_kind` (`malformed_wasm` /
`missing_test_export`) and aggregated into a dashboard bucket separate from
coverage, then gated.

- **Runner** (`tests/test262-runner.ts`): `TestResult` gains `hardError` /
  `hardErrorKind`; set at the instantiate-time `CompileError`/`LinkError` site
  (`malformed_wasm` — subsumes the #1850 verifier-failure-on-a-claimed-function
  case) and the no-`test`-export site (`missing_test_export`). Plain
  `compile_error` (the compiler explicitly refused — the coverage signal) is
  NOT a hard error.
- **CI harness** (`tests/test262-vitest.test.ts`): `recordResult` takes a
  `hardErrorKind`, writes `hard_error`/`hard_error_kind` into the JSONL, and
  tallies a `hard_errors` map surfaced in the report. Wired at the
  `workerResult.instantiateError` (→ `malformed_wasm`) and
  `workerResult.noTestExport` (→ `missing_test_export`) sites.
- **Report** (`scripts/build-test262-report.mjs`): aggregates `hard_error_kind`
  rows into a top-level `hard_errors` map, separate from `error_categories`.
- **Gate** (`scripts/check-test262-hard-errors.mjs`, `check:test262-hard-errors`):
  ratchet mirroring `check-ir-fallbacks` / `check-any-box-sites` —
  `--update` / `--update-on-decrease`, reads either the committed summary
  (`--summary`, default) or a raw results JSONL (`--jsonl`). Baseline
  `scripts/test262-hard-error-baseline.json`.
- **CI wiring** (`.github/workflows/test262-sharded.yml`):
  - PR-time enforcement — a "Hard-error stability gate" step runs the gate with
    `--jsonl` against the PR's merged results, failing if any kind exceeds the
    committed baseline (the general regression gate already fails on the
    underlying pass→compile_error flips; this surfaces the bucket explicitly).
  - `promote-baseline` runs `--update` and stages
    `test262-hard-error-baseline.json` atomically with the refreshed summary, so
    main always carries a matching baseline.

### Acceptance criteria — status
- [x] Reporting distinguishes `malformed_wasm` / `missing_test_export` from
      `unsupported_feature` / coverage `compile_error`.
- [x] Hard-error bucket surfaced (`hard_errors` in the report) + CI gate that
      fails on growth (mirrors the #1376 ratchet).
- [x] Verifier failure on a claimed function (#1850) routes here (instantiate
      `CompileError` → `malformed_wasm`) rather than being swallowed.
- [x] Baseline recorded (`scripts/test262-hard-error-baseline.json`); seeded
      empty and self-populated to the real ceiling by the first post-merge
      `promote-baseline --update`. The committed summary won't carry
      `hard_errors` until that first promote, and the gate treats absent as zero
      (no spurious fail in the interim).

## Test Results (2026-06-16)

- Gate unit-validated: fail-on-growth (`{}` → `malformed_wasm 1` exits 1),
  `--update` records the ceiling, `--update-on-decrease` ratchets,
  `--summary` and `--jsonl` inputs both work, scoped-JSONL (baseline ≥ subset)
  passes.
- `build-test262-report.mjs` verified on a synthetic JSONL: emits
  `hard_errors: {malformed_wasm:1, missing_test_export:1}` while a `Proxy
  unsupported` compile_error stays OUT of the bucket (only in
  `error_categories`).
- typecheck / lint / format all clean. No full test262 run (per dev protocol —
  CI validates conformance); the runner/harness changes are additive (new
  optional fields + two tagged call sites).
