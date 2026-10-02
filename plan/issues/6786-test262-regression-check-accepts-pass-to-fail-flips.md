---
id: 6786
title: "ci: `check for test262 regressions` (required) merges a PR that flips 4 tests pass→fail as long as net ≥ 0 — `docs/ci-policy.md` claims pass→fail 'cannot merge'"
status: ready
sprint: Backlog
created: 2026-09-30
updated: 2026-09-30
priority: high
horizon: m
feasibility: medium
reasoning_effort: medium
task_type: infrastructure
area: ci
language_feature: n/a
goal: ci-hardening
related: [3467, 3189, 2098, 1080]
requested_by: ttraenkler/claude-review
origin: "2026-09-30 codebase review (plan/agent-context/claude-codebase-review-2026-09-30.md) — H18"
---

# #6786 — the host test262 gate is a net gate, documented as a per-row gate

## Problem

`scripts/diff-test262.ts:37-38`, `:610-635`, `:2644-2688`: the required check
hard-fails only when `net_per_test < 0`, or when the regression ratio is
≥ 10 % **and** net < 0 **and** ≥ 10 regressions, or when a single bucket
exceeds 50. A PR with +5 / −4 merges green; each of the −4 is a test that
passed on main and fails after the merge.

`docs/ci-policy.md:52` says the check exists "so pass→fail regressions cannot
merge". The standalone lane already has a per-row strict mode for completed
editions (`scripts/test262-edition-ratchet.ts`, CLAUDE.md "Per-edition
conformance ratchet"); the host lane does not. 932 host rows are additionally
excluded from the diff through `scripts/test262-host-noise-quarantine.json`
(`counts.union_paths`).

## Correction

Pick one and make the doc match the code:

- **(a) per-row strict for completed editions, host lane too.** Extend the
  edition ratchet's `completed` handling to the host jsonl in
  `merge shard reports`; a pass→fail row in a completed edition fails
  regardless of net. Keep the net gate for editions still being worked.
- **(b) per-row strict everywhere with an explicit allow-list.** A pass→fail
  row fails unless the PR's issue file lists it under
  `test262-regressions-allow:` with a reason (the same pattern as the LOC /
  func budget allowances). Noise-quarantined rows stay excluded, but the
  quarantine file gets a `reason` and `added` per entry and a staleness alert
  like the trap-tolerance one.

Either way: rewrite `docs/ci-policy.md:52` to describe the actual rule, with
the thresholds.

## Acceptance

- A synthetic diff with +5 / −4 in a completed edition fails the check; the
  same diff in a non-completed edition fails under (b) or passes with a
  visible warning under (a).
- `tests/diff-test262.test.ts` (extend) covers the count-neutral swap case
  the edition ratchet already tests.
- `docs/ci-policy.md` names the rule, the thresholds, and the quarantine
  file's role.
