---
id: 5182
title: "Merge queue landed PRs despite red/absent merge_group verdicts — skip-twin check names satisfy the ruleset"
status: ready
sprint: current
created: 2026-08-29
updated: 2026-08-29
priority: critical
horizon: m
task_type: bugfix
area: ci
---

# The merge queue is merging groups whose required checks are RED

The merge-queue re-validation on the merged state is the **only** gate that
catches a regression the PR-level checks cannot see — that is the whole reason
`auto-park` (#2547) exists. On 2026-08-29 that gate was reporting `failure` and
the queue merged anyway. At least six merge shas in a six-hour window landed on
`main` with a failed required `Test262 Sharded` merge_group run.

## The clearest instance — PR #5199

| fact | value |
| --- | --- |
| merge sha (now on `main`) | `7e0dbb303e0bed5e6459380ce0dd1f497dc79832` |
| merge_group run | [33232469498](https://github.com/loopdive/js2/actions/runs/33232469498), conclusion **failure**, 04:19:18Z |
| `merge shard reports` (REQUIRED) | **failure** 04:18:10Z — step *Build merged standalone test262 report* |
| `check for test262 regressions` (REQUIRED) | **failure** 04:19:17Z — step *Fail on regressions* |
| auto-park bot comment + `hold` label | 04:19:37Z |
| **merged** | **04:27:46Z by `js2-merge-queue-bot[bot]`** |

The park bot did its job: it diagnosed, commented with both failing steps and
job-log links, and applied `hold`. Eight minutes later the same sha merged.
`git log origin/main` shows `7e0dbb303e` in place, and PR #5199 is `merged: true`
**while still carrying the `hold` label**.

## It is not one PR — the pattern

Every row below is a merge_group `Test262 Sharded` run that concluded `failure`
on a sha that is now an ancestor of `main`. In all four the shard matrix **did
run** (111 jobs each), so `SHARDS_RAN` was true — the earlier guess that these
failed before the matrix started is wrong.

| PR | merge sha | run | failing required job → step |
| --- | --- | --- | --- |
| #5203 | `4dfedbdc92` | 33228968665 | `merge shard reports` → *Standalone regression guard (#1897)* |
| #5204 | `523bd0428b` | 33229815117 | `merge shard reports` → *Fail if required test262 shards did not succeed* |
| #5187 | `84ad98d6d7` | 33230543407 | `merge shard reports` → *Fail if required test262 shards did not succeed* |
| #5199 | `7e0dbb303e` | 33232469498 | `merge shard reports` → *Build merged standalone report*; `check for test262 regressions` → *Fail on regressions* |

Two more in the same window fit the shape: run 33223074019 (`62ae321f21`,
PR #5194) and run 33233874554 (`2fe59c4c10`, PR #5209) both concluded `failure`
and both shas became the base of the next queue group, i.e. they landed.

**Consequence.** Four consecutive merges carried no passing merged-state sweep.
#5204 in particular is the commit that introduced the 24-unclassified condition
tracked by
[#5181](https://js2wasm.loopdive.com/dashboard/issue.html?slug=5181-standalone-stack-balance-error-shift)
— its own merge group was already red when it landed, and the gate it broke then
blocked everyone else.

## The first hypothesis is DISPROVEN — do not build the fix on it

The standing doctrine "a SKIPPED required check SATISFIES the requirement"
suggested the obvious story: `test262-pr-stub.yml` publishes check runs with the
same three names, and a `skipped`/`success` twin masked the red real run.

**That is not what happened on the merge sha.** Two independent facts:

1. `test262-pr-stub.yml`'s trigger block is `on: pull_request: branches: [main]`
   — it has **no `merge_group` trigger**. Its only mentions of `merge_group` are
   in comments.
2. Exactly four workflow runs exist on `7e0dbb303e`: `CLA Check` (success),
   `Differential test` (success), `CI` (success), `Test262 Sharded`
   (**failure**). No stub run.

So on the merge sha the two required contexts had exactly **one** producer, and
it reported `failure`. The masking theory may still explain PR-level enqueue
eligibility; it does not explain the merge.

## What to check next (needs endpoints this investigation could not reach)

The GitHub tooling available here exposes workflow runs and jobs, but not the
raw check-run list for an arbitrary sha, and not the repo ruleset. Both are
needed to close this:

1. **`GET /repos/loopdive/js2/commits/<sha>/check-runs`** for all four shas —
   enumerate every check run by name and conclusion, and identify which run
   satisfied each required context. This is the direct measurement; everything
   above is inferred from the Actions API.
2. **`GET /repos/loopdive/js2/rules/branches/main`** — read the
   `required_status_checks` rule *and its `bypass_actors`*. The merges were
   performed by the `js2-merge-queue-bot[bot]` GitHub App. If that app is a
   bypass actor on the rule, the queue merging a red group is the configured
   behaviour and the whole gate is decorative. This is the single most likely
   explanation left standing, and it is one API call to confirm or kill.
3. The **merge-queue rule's own settings** in the same ruleset —
   `check_response_timeout_minutes`, `min_entries_to_merge`,
   `min_entries_to_merge_wait_minutes`, `grouping_strategy`. A timeout that
   elapses while a 30-minute test262 run is still reporting can let an entry
   through on a stale verdict.
4. Whether GitHub **disarmed** native auto-merge on park (auto-arm-merge.yml
   claims it does) yet the queue entry survived — if the entry was already in
   flight, disarming the PR does not remove it.

## Proposed fixes, in order of confidence

1. **If a bypass actor is the cause** — remove `js2-merge-queue-bot` from the
   required-status-checks rule's bypass list. Nothing else needs to change.
2. **Give merge_group its own check names.** Even though the stub is not the
   culprit here, one context name with two possible producers is a live trap the
   repo has already been bitten by once (PR #496, backed out by `c9688f33b`).
   Publish `merge shard reports (merge_group)` / `check for test262 regressions
   (merge_group)` from `test262-sharded.yml` on the merge_group event and require
   *those* names for the queue, leaving the PR-level names to the PR lane.
3. **Make the stub structurally incapable of reporting on merge_group** — an
   explicit `if: github.event_name == 'pull_request'` on its three context jobs,
   so the property is enforced by the file rather than by its trigger list
   staying correct forever.
4. **Add a post-merge assertion.** A cheap `push`-on-`main` job that fails loudly
   when `HEAD`'s merge_group `Test262 Sharded` run concluded `failure` would have
   caught all six within minutes, whatever the root cause turns out to be.

## Acceptance criteria

- [ ] Check runs on `7e0dbb303e`, `84ad98d6d7`, `523bd0428b`, `4dfedbdc92`
      enumerated; for each required context, the run that satisfied it is named.
- [ ] Ruleset bypass actors for `main` read and recorded here.
- [ ] A fix landed that makes a red merge_group verdict block the merge, with a
      deliberate re-test proving it.
