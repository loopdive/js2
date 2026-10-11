---
id: 6786
title: "ci: `check for test262 regressions` (required) merges a PR that flips 4 tests pass→fail as long as net ≥ 0 — `docs/ci-policy.md` claims pass→fail 'cannot merge'"
status: done
assignee: "ttraenkler/claude-dev-6786"
branch: "claude/issue-6786-test262-per-row-gate"
sprint: Backlog
created: 2026-09-30
updated: 2026-10-02
completed: 2026-10-02
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

## Implementation Plan

**Decision (orchestrator, 2026-10-02): option (a).** A completed edition is
per-row strict on the js-host lane too, inside `merge shard reports`, reusing
the edition ratchet's `completed` designation. The net gate
(`check for test262 regressions`) is unchanged and keeps owning the editions
still being worked. Option (b)'s per-PR `test262-regressions-allow:` list is
deliberately not built.

Measured before choosing the host rule: the published host artifact
(`website/public/benchmarks/results/test262-editions.json`) has ES5 at
8,001 / 9,029, not 100 %. So the standalone rule ("every row of a completed
edition passes") cannot apply to the host lane. The host rule is "no row of a
completed edition that passed in the host baseline may stop passing".

1. `scripts/test262-edition-ratchet.ts` — new `--host-lane` mode (check 4 in
   the header), `runHostLane()`:
   - reads the host results jsonl and `--compare <host-baseline.jsonl>`;
   - reads ONLY the baseline's designations (`completed && ratcheted`, plus a
     new per-edition `host_exceptions` list). The baseline's counts and its
     `target: standalone` are not consulted, and standalone's `exceptions` are
     not honoured on the host lane, so excusing a row on one lane never
     loosens the other;
   - for every baseline-pass row of a held edition that is present in the
     run: non-pass → violation, except rows in
     `scripts/test262-host-noise-quarantine.json` (validated fail-closed with
     `validateHostNoiseQuarantineManifest` from `diff-test262.ts`; 150 of its
     932 paths are ES5) and pass → `compile_timeout` (#1192 flake class). Both
     are printed, not gated;
   - exit 1 on any violation; exit 2 (REFUSED) on: no test262 checkout, missing
     `--compare`, missing/empty results or baseline jsonl, an invalid
     quarantine, a `host_exceptions` entry without a reason, `--update`
     (the host lane banks nothing), or a run in which no baseline-pass row of a
     completed edition is present ("compared nothing").
   - `completionFields()` now carries `host_exceptions` through `--update`, so
     a standalone re-bank cannot silently drop them.
2. `.github/workflows/test262-sharded.yml`, job `merge-report`
   (`merge shard reports`):
   - "Check out test262 for the edition classifier" also runs when only the
     host lane ran;
   - new step "Host completed-edition per-row gate (#6786)" right after the
     #1668 catastrophic guard, comparing against the latest-main host jsonl
     that guard cloned (one fresh sparse clone if it is absent).
     `continue-on-error` + `id: host_completed_rows`;
   - deferred re-raise "Fail on host completed-edition breach (deferred,
     #6786)" after the #6760 one (`always()`, `outcome == 'failure'`), so the
     #1942/#1897 diagnostics still run, exactly like #6461/#6760. Its name is
     quoted so YAML does not read ` #6786)` as a comment.
3. `docs/ci-policy.md` — the required-checks row for
   `check for test262 regressions` (was: "required so pass→fail regressions
   cannot merge") now states the net rule and its thresholds; new §3
   subsection "What blocks a pass→fail row (#6786)" with the per-lane,
   per-edition table, the noise quarantine's role and the refusal rules; the
   inline-guard table and the §7 row updated to match.
4. `tests/test262-edition-ratchet-host-lane.test.ts` — synthetic jsonl
   fixtures on real test262 paths, written the way
   `tests/test262-edition-ratchet.test.ts` is.

## Resolution

Option (a) is in place. A pass→fail row of a completed edition (ES5) now fails
the required `merge shard reports` check on the js-host lane, whatever the net.
The standalone lane already had this through the per-edition ratchet.
`check for test262 regressions` is unchanged and is now documented as the net
gate it is.

Measured on synthetic jsonl (real test262 paths, run 2026-10-02):

| Diff (host baseline → run)                               | `diff-test262.ts` (net gate) | `--host-lane`                      |
| -------------------------------------------------------- | ---------------------------- | ---------------------------------- |
| 1 ES5 pass→fail + 11 ES2016 fail→pass (net +10)          | exit 0 (passes)              | **exit 1**, names the ES5 row      |
| 4 ES5 pass→fail + 5 ES2016 fail→pass (net +1)            | —                            | **exit 1**                         |
| ES5 count-neutral swap (one broken, one fixed)           | —                            | **exit 1**                         |
| same +10 diff, ES5 not `completed`                       | —                            | exit 0                             |
| flip in ES2016 (not completed), ES5 completed            | —                            | exit 0                             |
| ES5 flip on a quarantined path / to `compile_timeout`    | —                            | exit 0, row listed as not gated    |

Before this change no host step looked at editions at all, so every row above
merged when net ≥ 0. On a real host jsonl (the committed
`benchmarks/results/test262-current.jsonl`, 48,142 rows, compared with itself)
the gate checks 5,776 ES5 rows in 2.9 s and exits 0.

Tests: `tests/test262-edition-ratchet-host-lane.test.ts`, 22 cases: the
fail/pass cases above, `host_exceptions` honoured and standalone `exceptions`
not, every exit-2 refusal (no `--compare`, missing or empty results or
baseline jsonl, no completed-edition row in the run, invalid quarantine,
exception without a reason, no test262 checkout, `--update`), and the
workflow wiring (`continue-on-error` + `id`, deferred re-raise on
`outcome == 'failure'`, test262 checkout before the gate for a host-only
group, both inside `merge-report`). Against the pre-change script, 12 of the
22 fail. Green with `tests/test262-edition-ratchet.test.ts`, `issue-6760`,
`issue-6461`, `issue-3303` and `test262-per-lane-gating`.

Gates (exit codes): check-loc-budget 0, check-func-budget 0 (both also 0 with
`LOC_GATE_BASE` = origin/main 6fce22a8bb), check-coercion-sites 0,
check:oracle-ratchet 0, check:dead-exports 0, typecheck 0, format:check 0,
lint 0, compiler-boundaries inventory 0, check:issues 0,
check:done-status-integrity 0, check:issue-spec-coverage 0, and the other
quality-loop checks 0. The workflow YAML parses (`yaml` 2.8.3).
check:ir-fallbacks was not run: no `src/` file changed.

Left out or still open:

- **Compare-baseline lag.** The gate diffs against the latest-main host jsonl
  that the #1668 guard clones, not the exact merge_group base that
  `check for test262 regressions` resolves (#1956/#3467). An ES5 row fixed on
  main and broken again before `promote-baseline` publishes the fix is not
  caught. Closing that means moving the base resolution into `merge-report`.
- `tests/issue-3426.test.ts` has 2 failures **on main too** (checked against
  the HEAD workflow). It looks for the step `Compile-time regression guard
  (#1942)`, which is now named `… (#1942, #3447)`. Not touched here.
- CLAUDE.md's "Per-edition conformance ratchet" section still describes only
  the standalone lane. Not edited here; `docs/ci-policy.md` carries the rule.
- A new merge_group may run main's copy of the workflow YAML, so the new step
  may first gate the PR after this one.
