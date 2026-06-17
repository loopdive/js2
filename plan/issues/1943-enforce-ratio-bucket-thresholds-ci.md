---
id: 1943
title: "Enforce the documented regression thresholds (10% ratio, 50-per-bucket) in CI — today the hard gate is only net ≥ 0"
status: done
completed: 2026-06-16
assignee: ttraenkler/dev-a
sprint: 63
created: 2026-06-10
updated: 2026-06-16
priority: high
feasibility: easy
reasoning_effort: low
task_type: infrastructure
area: testing
language_feature: compiler-internals
goal: correctness
---
# #1943 — Enforce ratio/bucket thresholds in CI

## Problem

The documented merge criteria (`.claude/skills/dev-self-merge.md:187-189`)
are: `net_per_test > 0`, regression ratio < 10% of improvements, and no
path-bucket > 50 regressions. But the **enforced** CI gate
(`scripts/diff-test262.ts:336-340`) exits 1 only when
`improvements − regressions_wasm_change < 0`:

- A PR with 60 improvements and 55 unrelated real regressions **passes the
  required check** (ratio 92%, far beyond the documented 10%).
- The catastrophic guard fires only above 200 (`test262-sharded.yml`,
  `CATASTROPHIC_REGRESSION_THRESHOLD: "200"`); the standalone tolerance is
  ±15. A 150-test host regression that nets positive sails through.
- The finer thresholds exist only as **agent-followed skill text**; the
  auto-enqueue backstop (`scripts/enqueue-green-prs.mjs`) checks only
  check-greenness. An agent that skips the skill merges on net ≥ 0 alone —
  the documented quality bar depends on agent discipline, not branch
  protection.

## Proposed approach

1. Move the two checks into `diff-test262.ts`'s exit logic (the data is
   already computed there): fail when `R > 0 && R/improvements >= 0.10`, or
   when any 5-level path bucket > 50 — same definitions as the skill
   (`dev-self-merge.md:241` bucket logic already exists in the script's
   report path).
2. Keep flake reclassification (wasm_sha, compile_timeout) exactly as-is —
   these gates consume the already-filtered counts.
3. Update dev-self-merge.md to note CI now enforces; the skill's job
   reduces to interpreting ESCALATE cases.
4. Dry-run against the last ~20 merged PRs' artifacts to confirm no
   historical green PR would have been blocked incorrectly (if any would:
   examine — they were policy violations that merged).

## Acceptance criteria

- regression-gate job fails on a synthetic 10-improvement/5-regression diff
  (ratio 50%) and on a 60-in-one-bucket diff (tests using fixture JSONLs).
- Documented and enforced thresholds are byte-identical (single source:
  constants exported from diff-test262.ts, referenced by the skill doc).

## Source

Compiler quality review 2026-06. Related: #1668, #1897, dev-self-merge
skill, #1942.

## Resolution (2026-06-16, dev-a)

Moved the two thresholds into `scripts/diff-test262.ts`'s exit logic as the
single source of truth:

- Exported constants `REGRESSION_RATIO_LIMIT = 0.1`,
  `REGRESSION_BUCKET_LIMIT = 50`, `REGRESSION_BUCKET_PATH_DEPTH = 5`.
- `bucketRegressions(files)` groups regressed files by the first 5 path
  segments — byte-identical to the skill's `'/'.join(f.split('/')[:5])`.
- `evaluateRegressionThresholds({improvements, regressionsWasmChange,
  regressedFiles})` (pure, no I/O) returns failure reasons: ratio gate fires
  when `R > 0 && R/improvements >= 0.10`; bucket gate when any bucket > 50.
- The script's exit logic now fails (exit 1) on net < 0 **or** any threshold
  failure, printing a `GATE FAIL: …` line per reason. Operates on the same
  `noiseFiltered` set the net gate uses, so `compile_timeout` flaps and
  byte-identical (`wasm_sha`-unchanged) flips are already excluded — no double
  counting, flake handling unchanged (proposed-approach step 2).

**CI wiring:** the required "check for test262 regressions" job
(`test262-sharded.yml`) already maps `diff-test262.ts` exit 1 → `regressions=true`
→ "Fail on regressions" step fails the check. So the new ratio/bucket gates
are enforced by branch protection with no workflow change. (The separate
catastrophic/standalone guards in "merge shard reports" parse the text count
and are unaffected — they tolerate exit 1 by design and do their own
thresholding.)

**Module-import safety:** the bottom `main()` call is now guarded to run only
when `diff-test262.ts/.js` is the invoked script (`process.argv[1]`), so the
unit test can import the exported helpers without triggering the CLI.

**Skill sync (step 3):** `.claude/skills/dev-self-merge.md` Step 3 now notes CI
enforces criteria 2 & 3 and points at the exported constants as the single
source; the criteria table is the documentation twin.

**Tests:** `tests/issue-1943.test.ts` (7 cases) — ratio 50% fails, 60-in-one-
bucket fails (with ratio under 10%), clean passes, borderline 9% passes,
zero-improvements-with-regressions fails (∞ ratio), plus constant + bucket
grouping checks. Also validated end-to-end against synthetic fixture JSONLs
via the real CLI (ratio-50% → exit 1 despite net +5; 60-bucket → exit 1
despite net +640; clean and 9% → exit 0).
