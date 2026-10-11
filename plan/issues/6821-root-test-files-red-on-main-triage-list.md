---
id: 6821
title: "tests: root test files known red on main (linked-registry 14 + issue-4618, issue-3426 ×2, issue-4130 fast-path, issue-3113 ir-layering count, issue-1897 line wrap, issue-3934 paths-match ×2, issue-2520, issue-2856 ×2) — triage once #6783 seeds the known-failures baseline"
status: ready
sprint: Backlog
created: 2026-10-02
updated: 2026-10-02
priority: medium
horizon: m
feasibility: easy
reasoning_effort: low
task_type: infrastructure
area: tooling
language_feature: n/a
goal: maintainability
related: [6783, 6790, 6799, 6794, 3113, 1897, 3934]
requested_by: ttraenkler/claude-review
origin: "collected from the #6790, #6794, #6797, #6799 and #6783 implementation reports (2026-10-01/02); each row is the reporting agent's measurement on its branch, not re-measured by the filer"
---
# #6821 — the red root tests the review wave found

`tests/*.test.ts` ran under no required check until #6783 (known-failures
ratchet, seed-then-enforce). These files were reported red on main by the
implementations named; once the baseline is seeded, every row below must be
fixed or excused with a dated `known-failures-allow` entry and a reason.

| file(s) | reported by | note |
|---|---|---|
| 14 linked-registry failures + `tests/issue-4618*.test.ts` | #6790 | pre-existing before the per-instance registries |
| `tests/issue-3426*.test.ts` (2 cases) | #6786 | — |
| `tests/issue-4130-npm-compat-promotion-fast-path.test.ts` | #6799 | flags the `Preserve compiler boundary evidence (#3518)` step in ci.yml |
| `tests/issue-3113-ir-layering-gate.test.ts` | #6797 | expects 90 import lines; main is at 87 — the test should read `scripts/ir-layering-baseline.json`, not a literal |
| `tests/issue-1897*.test.ts` (1) | #6783 | a line-wrapped phrase in `docs/ci-policy.md` ~L694 no longer matches the grep |
| `tests/issue-3934*.test.ts` (2, paths-match block) | #6783 | — |
| `tests/issue-2520*.test.ts`, `tests/issue-2856*.test.ts` (2) | #6794 | fixture no longer produces warnings / 2 cases |

## Correction

Fix the cheap ones in this issue (3113 literal → baseline read; 1897 grep
tolerant of wrapping; 2520 fixture) and open one issue per real defect the
rest reveal. Do not skip or `it.fails` anything to get green (#3340 rule).

## Acceptance

- `node scripts/known-failures-gate.mjs --suite issue-tests` (after #6783
  lands) reports none of the files above as red, or each carries a dated
  allowance naming its follow-up issue.
