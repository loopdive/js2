---
id: 5344
title: "`Differential test` diffs against a baseline last refreshed 2026-07-19 and is not required — it blames whichever PR is in the queue"
status: done
completed: 2026-09-06
assignee: ttraenkler/senior-developer
sprint: current
created: 2026-09-05
updated: 2026-09-06
priority: high
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: infra
area: ci
goal: correctness
---

## Problem

`benchmarks/results/diff-test-baseline.json` was last committed **2026-07-19**
(`0b1a2cca8f`). `.github/workflows/diff-test.yml` and
`scripts/diff-test-gate.ts` exist to maintain it and evidently have not run
in seven weeks. Because the gate reports the *delta* against that baseline,
and because `Differential test` is **not** one of the six required checks
(verified: `cheap gate`, `merge shard reports`, `quality`,
`equivalence-gate`, `check for test262 regressions`, `cla-check`), the result
is a check that is red on clean `main`, attributes a weeks-old delta to
whichever PR happens to be in the merge queue, and stops nobody.

This is worse than no gate. On 2026-09-05 it cost the #5333 P0 fix (PR
#5620) real time: `closures/06-nested.js: match → mismatch` looked like a
closure regression on a closure PR. It reproduced with the change reverted
and at `4946cf70fe`, so the agent left evidence on the PR to stop anyone
parking it — but only because it checked.

## Acceptance criteria

1. The baseline is current: refreshed from `main`, committed, and the refresh
   path (`diff-test.yml` or a step in an existing post-merge workflow)
   demonstrably runs — show a run.
2. `Differential test` is green on clean `main` after the refresh.
3. The delta gate's own comment (which claims a workflow refreshes the
   baseline) matches reality.
4. **A recommendation, not a unilateral change**, on making it required —
   with the cost figure and the false-positive history from this issue. Adding
   a required check is a ruleset change (`docs/ci-policy.md` §7); propose it
   in the PR body.
5. Since this touches `.github/workflows/**` from a fork head, expect the
   `needs-manual-enqueue` label (#3584); that is a lead action, not a hold.

## Implementation Plan

1. Read `.github/workflows/diff-test.yml` — find its trigger and why it has
   not written the baseline since July. The three usual causes in this repo:
   a `paths:` filter that no longer matches; a concurrency group cancelled by
   the more frequent main pushes (see the `npm-compat-refresh` lesson in
   CLAUDE.md — never `cancel-in-progress` a job longer than its trigger
   interval); or a promotion step gated on a sha-equality check that always
   defers. Fix the actual cause.
2. Read `scripts/diff-test-gate.ts` for the baseline format and the refresh
   command. Regenerate locally from current `main`
   (`node --import tsx scripts/diff-test-gate.ts --update` or equivalent —
   confirm the flag), commit the result.
3. If the refresh belongs in a post-merge workflow, model it on
   `benchmark-refresh.yml` (direct push with the main-push-queue-gate), **not**
   on a PR-based promotion — and mind the "gate promotion on artifact
   freshness, never on commit-sha equality" rule.
4. Verify: run the gate locally against the new baseline on clean `main` → 0
   delta. Push, confirm the workflow runs and the check is green.
5. PR body: state cost, state the recommendation on `required`.

## Dispatch

Model: **sonnet**. CI plumbing with a known cause-space and a clear
definition of done; no compiler judgement needed.

## Implementation Notes (2026-09-06, senior-dev)

### Root cause — the workflow ran fine; the *publish* step had been deleted

`.github/workflows/diff-test.yml` was never broken and never stopped running.
It runs on every push to `main` and every `merge_group`, in about three
minutes, and it was green all along. What was missing was the last step.

`239062b95d` (2026-05-22, "ci: disable failing push-to-main steps in 4
workflows (post #491)") **commented out** the `Refresh baseline on main` step,
because the `main` ruleset had just started requiring the merge queue for every
write and `GITHUB_TOKEN` pushes began failing with `GH013: Changes must be made
through the merge queue`. The commented-out block left a note: "The baseline
can be refreshed manually via a normal PR when it drifts too far."

Nothing ever asked, so nobody ever did. The only later movement of the file was
`0b1a2cca8f` (2026-07-19), a side effect of a harness fix, not a refresh. The
mechanism was therefore off for **three and a half months**, not seven weeks —
the seven weeks in the problem statement measure the last accidental refresh,
not the last working one.

This distinction picked the fix. "The workflow is not running" would have been a
trigger/`paths:`/concurrency problem, which is where the plan's cause-space
pointed. "The workflow runs but cannot publish" is an authorisation problem, and
this repo already solved it: `benchmark-refresh.yml` and `refresh-baseline.yml`
push to `main` over SSH with the `MAIN_DEPLOY_KEY` deploy key, which the ruleset
lets bypass the queue. That key and its `baseline-promote` environment are live
today (`gh api repos/loopdive/js2/environments` lists it; benchmark-refresh
promoted at 01:49Z today). The disabling commit predates that solution; this
change just applies it.

### What was actually damaged (measured, not assumed)

`Differential test` is **not** red on clean `main` right now. Measured at
`ad9c7ec250` against the frozen baseline: **0 new regressions**, so the check
passes today. The harm is real but differently shaped, and worse:

1. **Non-attributable deltas.** The gate reports the delta between the
   candidate and a baseline from 2026-07-19, so it covers every commit merged
   since. On 2026-09-05 that surfaced as `closures/06-nested.js: match →
   mismatch` in PR #5620's merge group — a genuine regression that was already
   on `main` (it was #5335), reported against an unrelated closure PR. The gate
   was not lying about the corpus; it was lying about *whose* fault it was.
2. **16 of 120 corpus files were gated by nothing.** They were added after the
   freeze, so they appear in the report and in no baseline. `newFiles` is not
   gated, by design — the design assumes the baseline moves.
3. **3 improvements were unbanked** (`array/12-from-of.js`,
   `closures/07-arrow-this.js`, `closures/08-method-chain.js`). A regression
   back to their pre-July state would have gone unreported.

So the check was simultaneously too loud (blaming innocent PRs) and too quiet
(≈16 % of the corpus ungated). Both are one defect: the baseline stopped moving.

### What changed

- **`.github/workflows/diff-test.yml`** — the commented-out block is replaced
  by a real `refresh-baseline` job, `push: main` / `workflow_dispatch` only. It
  reuses the fresh `diff-test-report` artifact the existing job already
  uploads, so there is no second corpus run, and it deliberately skips
  `pnpm install` (the gate script imports only node builtins, so Node's type
  stripping runs it directly) — the job is well under a minute, which matters
  for the promotion guard below. `workflow_dispatch` also gives the path
  something you can run and watch rather than infer from silence; that
  inference is what let it stay broken since May.
- **`scripts/diff-test-gate.ts`** — gained `--update`, and a staleness
  fallback (below). Its two false claims are gone: the header no longer says
  improvements are "expected to be promoted into the baseline by a separate
  workflow on merge to main" as though that were happening, and the runtime
  line "On merge to main, the baseline will be refreshed to lock these in" now
  names the job that does it. (Acceptance criterion 3.)
- **`scripts/diff-test.ts`** — the report carries `generatedAt`. Read from the
  artifact, never from `git log -1 -- <path>`, which returns *empty* rather
  than erroring in the `fetch-depth: 1` checkouts every promote job here uses,
  and would silently launder a frozen artifact into "fresh".
- **`benchmarks/results/diff-test-baseline.json`** — regenerated on verified
  clean `main`, 99/104 → **115/120 match**.
- **`tests/issue-3915-main-push-queue-gate.test.ts`** — `diff-test.yml` added
  to the class-coverage list of workflows that push to `main`, whose comment
  asserted "these four are the whole class". That list is the thing that says
  whether a new pusher remembered its queue gate; leaving it at four would have
  made it wrong and useless in the same edit.
- **`README.md`** — it claimed CI gates "each PR"; the `pull_request` trigger
  was removed when the merge queue landed, so the gate runs in `merge_group`.

Two smaller corrections found while reviewing the job against how it would
actually run, both of which would have failed *quietly* rather than loudly:

- The job's `permissions:` block needs **`pull-requests: read`**. The queue gate
  reads `repository.mergeQueue` over GraphQL, which `contents: read` +
  `actions: read` does not cover. Because that gate fails OPEN by design (a
  broken gate must never freeze the baseline), the miss would not have broken
  the refresh — it would have warned and pushed on every run, silently
  surrendering the merge-group protection the job exists to respect.
- **`force_refresh` now forces the write, not just the queue bypass.** Mapped
  only onto the queue gate, a manual dispatch could never get past the "nothing
  changed" short-circuit, so the escape hatch could be pulled and produce
  nothing — an operator control that cannot demonstrate itself, which is this
  issue in miniature.

### Two design decisions worth the argument

**1. The baseline is now a projection, not a copy of the report.** The report
carries `ms_v8`, `ms_js2wasm`, `duration_s` and captured stdout, all of which
differ on every run. Committing them — which the old step did, via `cp` — means
the file changes on *every* push to `main`, so promotion pushes on timing
noise, and every one of those rebuilds the in-flight merge group and discards
its validation (#3915). The committed file is now `{file, outcome}` sorted,
plus the counts and the stamp: 28,022 → 9,778 bytes, and it moves only when a
corpus outcome moves. A refresh with nothing to say now writes nothing at all
(verified: a second `--update` is a no-op).

**2. Promotion is gated on commit-sha equality, against the letter of
CLAUDE.md — deliberately.** The project rule is "gate promotion on artifact
freshness, never on commit-sha equality with the revision you measured; replay
the artifact onto current main and retry instead." That rule comes from the
npm-compat livelock, where the artifact is **dashboard data**: replaying a
measurement onto a newer `main` costs nothing, and deferring every run froze
the dashboard for nine hours.

This artifact is a **gate baseline**, and replay reinstates the exact bug this
issue is about. A baseline measured at K and published onto K+2 records `match`
for a program that K+1 may have broken, so the next merge group blames the PR
under test for a regression already sitting on `main` — which is precisely what
happened to #5620. Attribution soundness requires the baseline to describe a
revision that actually existed.

The livelock the rule guards against cannot arise here, for reasons that are
structural rather than hopeful:

- The npm-compat livelock needed `cancel-in-progress`, which killed the newer
  runs that the older ones were deferring to. This workflow has no
  `concurrency:` block at all, so every superseding push gets its own run.
- The same guard in `benchmark-refresh.yml` — a *longer* job — promotes several
  times a day (`ad3e95fcce`, `d0546d6167`, …). This job is shorter, so its
  window is strictly better than one already known to work.
- If a relentless queue did starve promotion anyway, the failure is now
  self-announcing rather than silent — which is the third decision:

**3. A stale baseline downgrades a regression to a warning (beyond the literal
acceptance criteria).** Criteria 1-3 restore the mechanism; nothing in them
stops it breaking again the next time a ruleset, a secret or a runner image
changes, and the whole cost of this issue came from *not noticing* for three
months. So: `--update` re-lands the baseline when outcomes move **or** when its
stamp is older than `HEARTBEAT_DAYS` (7), which keeps `generatedAt` meaningful
as "verified against `main` this recently" rather than "last time an outcome
moved". If the stamp ever exceeds `STALE_DAYS` (21, i.e. three missed
heartbeats) or is missing entirely, the gate prints the regressions, emits a
`::warning` saying the delta spans every commit since the baseline and is not
attributable, and exits 0.

That is a deliberate trade: a broken refresh path now yields a loud annotation
on the run instead of a red check pointing at an innocent PR. Given the check is
not required, "red" bought nothing anyway; the annotation names the real defect.
The gate still fails hard (exit 1) against a current baseline — verified below.

### Verification

All on `ad9c7ec250` with a clean tree (`git status --porcelain` empty, `src/`
untouched at `upstream/main`).

| Check | Result |
| --- | --- |
| Corpus on clean main | 120 programs, **115 match** (95.8 %), 2 mismatch, 3 runtime_error, 48.3 s |
| Gate **before**, stale baseline | exit 0 — 99/104 baseline, 16 ungated new files, 3 unbanked improvements |
| Gate **after**, refreshed baseline | exit 0 — **0 new files, 0 regressions, 0 improvements: zero delta** |
| Synthetic regression vs **stale** baseline | exit **0** + `::warning`, "not attributable" (no misattribution) |
| Synthetic regression vs **fresh** baseline | exit **1**, "delta gate FAILED" (the gate still bites) |
| `--update` idempotency | second run writes nothing: "unchanged — outcomes identical" |
| `tests/issue-3915-main-push-queue-gate.test.ts` | 36 passed |

### Considered and not done

**Delete the committed baseline; diff the merge candidate against its own merge
base inside `merge_group`** — the same shape as the optimize lane's
self-maintaining gate (#1941) and test262's per-SHA merge-base diff (#3467).
That removes the frozen artifact entirely, so it cannot go stale, cannot
mis-attribute, and needs no push to `main` at all (dropping this workflow back
out of the #3915 pusher class). It costs a second corpus run per merge group
(~+2 min) and is a larger change than this issue's plan, which specifies a
committed baseline plus a refresh path. Worth filing if the refresh path proves
troublesome again; the staleness fallback added here is the cheap version of the
same guarantee.

### On making `Differential test` required

Recommendation and cost analysis are in the PR body — it is a ruleset change
(`docs/ci-policy.md` §7) and therefore a lead decision, not part of this change.
