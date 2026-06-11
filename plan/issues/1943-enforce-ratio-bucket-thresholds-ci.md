---
id: 1943
title: "Enforce the documented regression thresholds (10% ratio, 50-per-bucket) in CI — today the hard gate is only net ≥ 0"
status: backlog
sprint: Backlog
created: 2026-06-10
updated: 2026-06-10
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
