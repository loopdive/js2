---
id: 4093
title: "`auto-refresh-prs` fires at ~0.7/hour against a declared 3/hour — a ~1h median floor on every PR's time-to-merge, and every run reports success"
status: ready
sprint: current
created: 2026-08-02
updated: 2026-08-02
priority: medium
horizon: s
feasibility: medium
reasoning_effort: medium
task_type: infrastructure
area: ci
language_feature: n/a
goal: dogfood
related: [35, 1758, 2786, 3878, 3904]
---

## ⚠ REFRAME 2026-08-02: the cadence is HALF of a loop — `[skip ci]` commits are the other half

Found by the shepherd measuring a refresh that *worked* and was undone 11
minutes later; every claim below re-verified from source by the tech lead.

The 12:16Z refresh log reads `updated=2 skipped=0 failed=0` — it did its job.
By 12:27Z both PRs were `BEHIND` again, each lacking **exactly one commit**:

```
c2b9023e  12:14:39Z  chore(test262): refresh sharded baseline — … [skip ci]
```

Authored before the refresh, **pushed after** — the refresh raced the
baseline-promote bot and lost.

**Why one bookkeeping commit disqualifies every open PR**
(`scripts/enqueue-green-prs.mjs:114`):

```js
const ENQUEUEABLE = new Set(["CLEAN", "HAS_HOOKS"]);
```

`BEHIND` is not in it. So:

> **A `[skip ci]` commit says "this changes nothing that needs testing" — and it
> is simultaneously enough to remove every open PR from enqueue eligibility.**

The loop: merge → `[skip ci]` baseline commit → all open PRs `BEHIND` →
un-enqueueable → wait ~1 h for a refresh (#4093's cadence half) → refresh →
possibly raced by the *next* baseline commit → repeat. Measured frequency of
the trigger: **six** `[skip ci]` commits in ~5.5 h (12:14, 11:43 ×2, 10:54,
08:49, 06:49) — this fires repeatedly, not occasionally.

**Design observation, recorded but NOT prescribed:** the enqueue script's own
comment (line 817) says *"the merge queue builds merge groups against main
itself, so PR branches never need auto-updating from CI."* If that holds,
requiring `CLEAN` is stricter than the queue needs, and admitting `BEHIND`
(never `UNSTABLE` — that exclusion is load-bearing, #3878/#3904) would break
the loop without touching cadence. ⚠ The same file documents the 2026-06-11
incident (17 bot-updated BEHIND PRs stranded in `action_required`), so this is
a queue-design decision with a live blast radius — stakeholder call, not a
lane's. An alternative with a smaller radius: exempt `[skip ci]`-only
divergence from the BEHIND disqualification, since by its own declaration such
a commit cannot change test outcomes.

# The cron declares 3/hour and delivers ~0.7/hour

Measured 2026-08-02 by the PR-queue shepherd, independently re-measured by the
tech lead before filing.

`.github/workflows/auto-refresh-prs.yml` declares:

```yaml
schedule:
  - cron: "*/20 * * * *"    # 3 runs/hour
```

Actual run starts over the last ~23 h (16 consecutive `schedule` runs,
2026-08-01T12:14Z → 2026-08-02T11:04Z):

| gap | count |
| --- | --- |
| 53–73 min | 9 |
| 82–103 min | 3 |
| **126–210 min** | 4 |

```
median gap ~63 min      worst gap 210 min (overnight)
actual ~0.71 runs/hour  declared 3.0 runs/hour   -> ~4.2x shortfall
recent: 01:10 -> 04:41 -> 07:28 -> 09:35 -> 11:04   (210, 167, 126, 88 min)
```

**Not a config bug.** The cron expression is correct. The pattern — roughly
hourly during the day, degrading to 2–3.5 h overnight — matches GitHub's
documented behaviour of delaying and deprioritising scheduled workflows under
load. We do not control it.

## Why it costs throughput

Every merge to `main` puts open PRs into `BEHIND`. `auto-enqueue` accepts only
`{CLEAN, HAS_HOOKS}`, and `BEHIND` blocks `CLEAN`. So **the refresh cadence is a
hard floor on every PR's time-to-merge**: a median ~1 h of dead time per drift
event, up to 3.5 h overnight. With merges landing faster than the refresh fires,
PRs go `BEHIND` within minutes of each merge and then sit.

This is consistent with the whole 2026-08-02 session: PRs repeatedly observed
`BEHIND` with no failing check, waiting only on a refresh.

## ⚠ Why nobody noticed — the failure is INVISIBLE BY CONSTRUCTION

**Every one of those 16 runs reports `success`.** Nothing is failing. The runs do
exactly what they should, when they eventually happen.

The wrong quantity is the **cadence**, and cadence is not a value any check
looks at. There is no assertion anywhere that run N+1 follows run N within some
window. This is the [[reference_silent_empty_is_indistinguishable_from_real]]
family in a form worth naming separately:

> **A green run says the work was done. It says nothing about whether it was
> done ON TIME. If timeliness is the load-bearing property, greenness is not
> evidence.**

The same shape as the `npm-compat-refresh` livelock (CLAUDE.md): CI green for
9 hours while the artifact did not move.

## Work

Sizing note: do NOT assume a fix is available — GitHub scheduler delay is not
ours to control. The tractable parts are **detection** and **compensation**.

1. **Detection (do this first, it is cheap and it is the real gap).** Emit the
   observed gap since the previous run, and fail/warn past a threshold — e.g.
   `>45 min` on a 20-min cron. Any monitor added here **must ship a positive
   control** proving it fires on a known-late run; replay the 210-min gap above.
2. **Compensation.** Options, in rough cost order:
   - keep `workflow_dispatch` as the manual escape hatch (already present, with
     a `reason` input) and let the shepherd fire it when `BEHIND` PRs are
     sitting — **granted 2026-08-02, scoped, see below**;
   - trigger a refresh from the *merge* event rather than only the clock, since
     a merge is precisely what creates `BEHIND` PRs. ⚠ A push/merge trigger was
     deliberately REMOVED once before for churn racing the serial merge queue
     (see the workflow header, #35) — re-adding it must address that, not
     rediscover it;
   - shorten the cron, accepting GitHub may throttle it anyway.
3. Do **not** "fix" it by widening `auto-enqueue` to accept `BEHIND`. That
   ordering exists for a reason.

## The manual dispatch is SAFE — verified, not assumed

`workflow_dispatch` runs the identical guarded code path as the cron; only the
trigger differs. Verified in the workflow source:

- only `mergeStateStatus == BEHIND` PRs;
- skips drafts;
- skips `hold` / `do-not-merge` / `wip` / `blocked` labels;
- **skips PRs already in the merge queue** — a real GraphQL `mergeQueue` lookup,
  because updating a queued branch rebuilds the forming group and cancels the
  head's in-flight `merge_group` run (#1758,
  [[project_merge_queue_requeue_cancels_run]]);
- skips `DIRTY`;
- `update-branch` self-gates with HTTP 422 when a branch is already current.

**Scope of the grant:** fire it only when `BEHIND` PRs are actually sitting.
Never on a timer and never in a polling loop — that re-implements the cron and
burns runner capacity ([[feedback_passive_github_watcher_never_poll]]). Always
record a `reason`.

### ⚠⚠ A MANUAL DISPATCH CANCELS AN IN-FLIGHT SCHEDULED RUN — check first

Discovered by the shepherd on first use of the grant, and it is a hard
precondition, not a nicety. The workflow carries:

```yaml
concurrency:
  group: auto-refresh-prs
  cancel-in-progress: true
```

So a `workflow_dispatch` issued while a scheduled run is executing **kills that
scheduled run**. The compensation destroys the thing it is compensating for.

**Required precondition before dispatching: confirm no run is in flight.**

This is the *same hazard family* as the `npm-compat-refresh` livelock recorded
in CLAUDE.md — "never `cancel-in-progress` a job longer than its own trigger
interval". The twist here is nastier, because the interference is **between the
manual and scheduled triggers of one workflow**:

- dispatching on a **timer** (explicitly forbidden by the grant) could cancel
  *every* scheduled run as it starts, starving the cron completely;
- and it would be **invisible** — the manual runs all report `success`, the
  cancelled scheduled runs just report `cancelled`, and the only wrong quantity
  is once again the **cadence**, which nothing checks.

Anyone implementing work item 2 (compensation) must treat this concurrency
group as part of the problem, not as neutral infrastructure. A merge-triggered
refresh would collide with the same group.

### ⚠ SECOND PRECONDITION — skip a DETERMINISTICALLY-FAILING PR

Found 2026-08-02 by the shepherd auditing **its own** dispatches, and it is the
same shape as the in-flight guard: the compensation quietly does nothing, and
the nothing is invisible.

A PR whose **required** check fails deterministically **cannot benefit from a
refresh**. Rebasing it re-runs a known-failing suite and changes its state
(`BEHIND → BLOCKED`), so each cycle *looks like* progress while being none.

Measured on #4002: **5 of 5 CI runs failed on the identical step**
(`quality` → `Changed root test files must pass (#3008)`), and those five runs
map **1:1 onto the five refresh events** of the day (07:28, 09:35, 11:04,
11:37, 12:00). Two were manual dispatches under this grant. The PR had been
cycling `BEHIND → refresh → CI fails → BEHIND` for ~4.5 h.

**Rule:** before dispatching, skip — and do not count as justification — any PR
whose **last CI run failed a required check on the same failing step as the run
before it**. A deterministically-failing PR needs an **owner**, not a rebase.

Note the interaction with the invisibility theme: the workflow reports
`success`, the PR's state genuinely changes, and the refresh genuinely ran. The
only thing that did not happen is the thing it was for. Both preconditions on
this grant exist because *"the action completed"* and *"the action helped"* are
different claims, and only the first is observable by default.

### First use of the grant — worked, recorded as the reference pattern

2026-08-02T11:37:07Z, conditions checked before firing: two PRs (#4028, #4002)
sitting `BEHIND`, last scheduled run 33 min prior against a declared 20, **and
no run in flight**. Result confirmed by content, not by the workflow's green:

```
91c942b4  11:37:15Z  js2-merge-queue-bot[bot]  Merge branch 'main' into ...
```

Eight seconds after dispatch. Both PRs moved `BEHIND → BLOCKED` — branches
updated and CI re-running, which is the intended end state. One dispatch, not a
loop.
