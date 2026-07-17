---
id: 3008
title: "process gap: tests/issue-*.test.ts are not uniformly wired into required CI (silent regressions)"
status: done
completed: 2026-07-17
sprint: current
priority: low
assignee: ttraenkler/fable-s2
created: 2026-07-03
feasibility: medium
reasoning_effort: low
task_type: chore
area: ci
language_feature: n/a
goal: quality-infra
related: [3007, 2767]
horizon: s
---

# #3008 — `tests/issue-*.test.ts` are not uniformly wired into required CI

## Finding (documentation only — do NOT fix the CI config in this issue)

While resolving #3007 (an `any`-context computed-index read emitting invalid
Wasm), we found that `tests/issue-2767.test.ts` had **6/11 tests failing on
`main`** with `Invalid Wasm binary` and it had **regressed silently** — no
required gate caught it.

Root cause of the blind spot: the required `quality` gate (`ci.yml`) and the
test262 conformance shards do **not** run the per-issue regression suites under
`tests/issue-*.test.ts` as a blocking check. A per-issue test can therefore go
red without failing any required check, so a codegen change elsewhere can break
a previously-fixed issue's guarantees and merge clean. #3007 is exactly that:
the underlying `__vec_get` funcIdx desync was latent, the Date/`toISOString`
test262 cluster (15/17 host) never exercised the specific `any`-return shape,
and `issue-2767.test.ts` — which did — was not gating.

A secondary, unrelated symptom found in the same sweep: at least one per-issue
file is outright broken at load time (`tests/array-externref-indexof.test.ts`
imports `./helpers.js`, which does not exist — it should be
`./equivalence/helpers.js`). A file-level import error like this silently
contributes **zero** assertions, so it too would never have flagged.

## Why it matters

The per-issue suites are the project's regression memory. If they are not a
blocking gate, that memory does not protect `main` — a fixed issue can quietly
re-break (as #2767 did).

## Suggested direction (for whoever picks this up — not prescribed here)

- Decide whether `tests/issue-*.test.ts` (or a curated subset) should be a
  required blocking check, and wire it into `quality` (or a dedicated job) if so.
  Watch RAM/time — the full vitest suite can OOM in constrained envs (see
  CLAUDE.md); a sharded or fast-subset run may be needed.
- Add a lint/CI guard that fails when a `tests/**/*.test.ts` file errors at
  collection time (import resolution), so a broken-import test can't pass by
  contributing zero assertions.
- Fix the concrete `array-externref-indexof.test.ts` import path as a trivial
  follow-up.

## Acceptance criteria

- A decision is recorded on whether/how per-issue suites gate CI, with the
  RAM/time tradeoff considered.
- (If adopted) the wiring lands and a deliberately-broken per-issue test fails
  CI.

## Decision + implementation (2026-07-17, fable-s2)

**Audit.** Population: 2,092 root `tests/*.test.ts` files (1,739 `issue-*`)
run by NO CI job (only `tests/equivalence/` (#1659), `linear-*`/`c-abi`/`simd*`
(#2139), and ~7 individually-named files in `quality` were wired). A 30-file
random sample on main: **12/30 files failing (40%), 57 failing assertions** —
dominated by stale-harness rot (e.g. missing the newer `string_constants`
import namespace — same mechanism as the `externref.test.ts` 5/5 break) plus
genuine silent regressions (four found on 2026-07-16 alone: #1284
ambient-shadow extern-class break, JSON.stringify 3/9, #3307, #3316).

**Decision (RAM/time tradeoff).** The full suite is ~9 CPU-hours single-fork —
infeasible as a per-PR required gate. Two-layer wiring instead:

1. **Post-merge detector** — `.github/workflows/issue-tests.yml`: push:main
   (burst-deduped via a latest-wins concurrency group) + 6-hourly cron +
   dispatch; 12 shards (max-parallel 6, off the merge critical path), merged
   by `scripts/issue-tests-gate.mjs` against a known-failures baseline stored
   in `loopdive/js2wasm-baselines` (`issue-tests-baseline.json` — workflows
   cannot push to main, GH013). First run BOOTSTRAPS the baseline (the rot
   backlog); newly-fixed tests auto-ratchet it down
   (`--update-on-decrease`); any NEW failure fails the run → red on main
   within one run instead of silent rot. Collection-time errors (broken
   imports) count as failures (`<file> :: <collect>`), closing the
   zero-assertion blind spot.
2. **Per-PR born-green gate** — `quality` step "Changed root test files must
   pass (#3008)": every root test file a PR adds or modifies must pass
   (fix-on-touch for rotted files; >20-file mass edits skip with a warning).
   New test files are automatically inside the detector's enumeration — a
   test cannot be born unwired.

**Not adopted:** making the full suite a required per-PR/merge_group check
(cost would throttle the queue), and auto-committing the baseline to main
(GH013 — merge queue blocks workflow pushes; the #491 planning-artifacts
auto-commit hit the same wall).

**Follow-ups:** the bootstrapped baseline enumerates the failing-on-main set —
triage/file the rot clusters from `js2wasm-baselines/issue-tests-baseline.json`
after the first run (PO/tech-lead sweep; the class-suite cluster
(`class-methods` 17F/0P etc.) is likely one stale-harness fix). The
`array-externref-indexof.test.ts` broken import cited in the finding no longer
exists on main (already removed/fixed).
