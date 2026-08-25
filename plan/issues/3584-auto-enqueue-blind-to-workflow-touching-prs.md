---
id: 3584
title: "auto-enqueue.yml can never enqueue a PR that touches .github/workflows/** (silent forever-stall)"
status: done
sprint: 78
created: 2026-07-24
updated: 2026-08-18
completed: 2026-07-31
assignee: ttraenkler/dev-ci-3584
priority: high
horizon: s
feasibility: medium
task_type: ci
area: ci, merge-queue
goal: release-pipeline
related: [2786, 3456, 2547]
origin: "PR-queue shepherd sweep 2026-07-24. PR #3567 sat green+CLEAN for 6h45m with zero enqueue attempts; diagnosed as an App-token permission hole, rescued by a one-shot PAT enqueue."
---

# #3584 — `auto-enqueue.yml` is structurally blind to PRs touching `.github/workflows/**`

## Problem

Any PR whose diff includes a file under `.github/workflows/**` is **permanently
un-auto-enqueueable**. This is not "slow" or "picked up on the next cron" — it is a
**silent forever-stall**. The PR stays green, `CLEAN`, unlabelled, comment-free, and
simply never enters the merge queue. Nothing in the pipeline surfaces it: there is no
`hold` label, no bot comment, no failing check. It just sits.

Since #2786 made the server-side workflow the _single_ enqueuer and devs explicitly
stand down after CI goes green, there is no agent left watching. The only thing that
recovers such a PR is a human or the PR-queue shepherd noticing it in a manual sweep.

## Evidence (PR #3567, 2026-07-24)

PR #3567 (`fix(#3456): remove queue-unstick automated re-enqueue loop`) touched:

```
.github/workflows/approve-fork-runs.yml
.github/workflows/auto-park-merge-group-failures.yml
.github/workflows/queue-unstick.yml
docs/ci-policy.md
plan/issues/3456-ci-queue-unstick-requeue-churn.md
scripts/approve-fork-runs.mjs
scripts/auto-park-merge-group-failure.mjs
scripts/unstick-merge-queue.mjs
```

- All 7 required checks `SUCCESS`; not a draft; no `hold`; no reviews requested.
- Open and green from **15:06 UTC**; still un-enqueued at **21:55 UTC** (6h45m).
- `auto-enqueue.yml` ran ~20 times in that window. **Every single run** logged:
  ```
  - #3567 skip (BLOCKED)
  ```
  (e.g. runs `30126231181` @21:01, `30129070114` @21:50.)
- Meanwhile, querying with a **user PAT** at the same moment:
  ```
  $ gh api repos/loopdive/js2/pulls/3567 --jq '.mergeable_state'
  clean
  $ gh pr view 3567 --json mergeStateStatus   # GraphQL, user PAT
  CLEAN
  ```
- The PR timeline had **zero** events and **zero** comments — it was never enqueued,
  never ejected, never parked. It had simply never been attempted.

**The divergence is the whole tell:** `mergeStateStatus` / `mergeable_state` is
computed **relative to the querying token's permissions**. `BLOCKED` does not mean
"this PR is not ready"; it means "_you_ cannot merge this PR right now."

## Mechanism

`auto-enqueue.yml` mints a scoped GitHub App installation token
(`actions/create-github-app-token@v3`) and hands it to
`scripts/enqueue-green-prs.mjs` as `GH_TOKEN`. That App installation does **not**
hold the `workflows` permission.

GitHub refuses to let a token without `workflows: write` land changes to files under
`.github/workflows/**`. That refusal is surfaced ahead of time as
`mergeStateStatus: BLOCKED` for that token. `enqueue-green-prs.mjs` treats any
non-`CLEAN` state as "not my problem yet" and skips — correctly, for every other
cause of `BLOCKED` (checks still running, review required, drift), but fatally here,
because for this cause the state **never changes**.

The ~30-min cron backstop shares the same token, so it re-derives the same `BLOCKED`
and is equally incapable of recovery. There is no self-healing path.

**Blast radius is not niche.** CI/infra work is exactly the category of PR that
touches `.github/workflows/**`, and it is also the category whose stalling degrades
the pipeline that everything else depends on — including, ironically, #3567 itself,
which was a fix to the merge queue.

## Options (weigh; do not implement blind)

### A. Grant the App `workflows: write`

- **Pro**: one-line permission change, fixes the class outright, keeps a single
  enqueuer and a single code path.
- **Con**: materially widens the blast radius of a compromised or confused-deputy App
  token — it would gain the ability to land arbitrary CI workflow changes, which is
  effectively arbitrary code execution on runners with repo secrets. The App is
  currently invoked from `workflow_run`, a trigger that has historically been a soft
  spot for privilege confusion. **This is the option that needs a real security
  decision, not just a config edit.**

### B. PAT fallback in `scripts/enqueue-green-prs.mjs`

- Detect a workflow-touching PR (`gh pr view <n> --json files`, any path matching
  `.github/workflows/`) and, only for those, re-query and enqueue with a stored PAT
  secret.
- **Pro**: keeps the App token narrow for the 95% case; the elevated credential is
  used on a small, explicitly-detected path.
- **Con**: introduces a second credential and a second code path; the PAT is a
  long-lived user credential in repo secrets (rotation burden), and the detection
  itself becomes a security boundary that must not be spoofable.

### C. Minimum viable: make it loud

- When a PR is skipped as `BLOCKED` **and** has all required checks green **and** has
  been green for more than ~15 minutes, log a distinct warning naming the PR, and
  (optionally) apply a `needs-manual-enqueue` label.
- **Pro**: does not touch the permission model at all; converts a silent
  forever-stall into a visible one, which is the actual harm here. Cheap, safe,
  independently useful even if A or B lands later.
- **Con**: still requires a human/shepherd to act; does not fix the class.

**Suggested shape**: land C unconditionally as a safety net (it is valuable
regardless), then decide A vs B as a deliberate security call.

## Acceptance criteria

1. A PR that touches `.github/workflows/**` and is otherwise green either (a) gets
   auto-enqueued, or (b) is surfaced loudly within ~15 min — not silently skipped.
2. `scripts/enqueue-green-prs.mjs` distinguishes _transient_ `BLOCKED` (checks pending
   / drift) from _permanent_ `BLOCKED` (token cannot merge these paths) in its log
   output, rather than emitting the same `skip (BLOCKED)` line for both.
3. If option A is chosen, the permission widening is recorded in `docs/ci-policy.md`
   with the security rationale.
4. Regression check: re-run the scenario against a scratch PR touching a workflow file
   and confirm it does not strand.

## Notes

- Workaround in the meantime (used to rescue #3567): the PR-queue shepherd enqueues
  once with a user PAT via the GraphQL `enqueuePullRequest` mutation. **Once** — never
  in a loop (see #3456 / `project_merge_queue_requeue_cancels_run`).
- Related: #2786 (server-side auto-enqueue became the single enqueuer, which is what
  turned this from "a dev would have noticed" into a silent stall), #3456 (re-enqueue
  churn — the reason a loop is not an acceptable mitigation), #2547 (auto-park, the
  other merge-queue safety net).

---

## RE-VERIFIED 2026-07-31 — still reproduces. Option C landed.

### Read this first: OBSERVED vs RECONSTRUCTED

These two must not blur. Wrong attributions have survived in this repo for days by
recording a plausible mechanism as if it were established — including twice in this
issue's own memory note.

**OBSERVED (measured, 2026-07-31).** The failing cell is **fork-head AND touching
`.github/workflows/`**. Not workflow-touching alone; not fork-head alone.

| head repo | touches `.github/workflows/` | app-token auto-enqueue | evidence |
| --- | --- | --- | --- |
| fork (`ttraenkler`) | **yes** | **NO — 4/4 needed a human PAT enqueue** | #3567, #3590, #3602, #3609 |
| fork (`ttraenkler`) | no | yes, by `js2-merge-queue-bot` | #3887, #3889, #3890 (queued 2026-07-31) |
| upstream (`loopdive`) | yes | yes, by `js2-merge-queue-bot` | #3690, #3843, #3833 |

Supporting current facts:

- `gh api /apps/js2-merge-queue-bot` → permissions are `actions:write, checks:read,
  contents:write, issues:write, metadata:read, pull_requests:write`. **No `workflows`.**
- `ENQUEUEABLE = new Set(["CLEAN","HAS_HOOKS"])` in `scripts/enqueue-green-prs.mjs`
  is unchanged, so any non-`CLEAN` state is skipped.
- Ruleset `16700772` has **no required-review rule**. Its bypass actors are
  `DeployKey` and `RepositoryRole 5` (admin) at `bypass_mode: always` — so an
  **admin PAT reading `CLEAN` is a bypass artifact** and is *not* the enqueuer's
  view. Never diagnose this class from a human token's `mergeStateStatus`.
- The load-bearing observable: **#3567 was `BLOCKED` to the app token after 6h45m
  green.** Ordinary `BLOCKED` clears in minutes.

**RECONSTRUCTED, NOT MEASURED.** "The app token lacks `workflows`, and GitHub
treats a fork-authored workflow change differently from a same-repo one, so it
reports `BLOCKED` to that token forever." This story fits 4-vs-9 exactly and is
probably right. **It has not been tested.** No fix here depends on it, and
option A must not be justified by it.

### #3884 is NOT a counter-example — it tested nothing

#3884 was fork-head *and* workflow-touching and merged normally on 2026-07-31, so
it looked like a refutation. It is not:

- Filtered server-side on `workflows/auto-enqueue.yml/runs` (never inferred from a
  truncated recent-runs page): runs fired at **10:33:16, 10:33:43, 10:35:01Z**, then
  **nothing until 11:01:30Z**.
- #3884 became fully green at **10:36:28Z** (`measure-and-gate`, the last finisher)
  and was hand-enqueued by `ttraenkler` at **10:42:56Z**.
- **The app never observed it green.** The one app-token reading of it,
  `#3884 skip (BLOCKED)` at 10:35:14Z, was taken while checks were still pending —
  a *transient* BLOCKED.
- The 26-minute hole is itself **#3889** (the `workflow_run` trigger allowlist
  missed "Refresh Benchmarks" as last finisher) — which is precisely what #3884 fixed.

### What landed: option C only (`scripts/enqueue-green-prs.mjs`, script-only)

`classifyBlockedSkip()` — pure, exported — splits `BLOCKED` into:

- **transient** — a check is pending / red, or the PR went green < 15 min ago.
  Silent, exactly as before.
- **suspected permanent** — `BLOCKED` + zero failing + zero pending + green for
  at least `STALL_MINUTES` (15, env-overridable).

A suspected-permanent PR gets a distinct `::warning::` block at the end of the sweep
log naming the PR numbers, plus the informational label **`needs-manual-enqueue`**
(deliberately **absent from `HOLD_LABELS`** — a hold would convert a visibility aid
into the very stall it reports, since a held PR is skipped by this sweep forever).
The label is dropped automatically if the PR later enqueues, so it cannot rot.

Cost is scoped: only `BLOCKED` PRs pay the two extra API reads; `BEHIND`/`DIRTY`/
`UNKNOWN` short-circuit with none. Untrusted-author PRs are never labelled — an
external PR is *supposed* to need a deliberate human enqueue (#2549).

**C makes the stall VISIBLE. It does not fix the class.** A PR in the failing cell
still sits un-enqueued and still needs one deliberate manual enqueue. Anything that
reads this issue as "closed, so workflow PRs enqueue now" is misreading it.

### Non-vacuity — validated by kill-switch, both directions

- Disable the pending-checks guard → `a pending check means in-flight, never a
  permanent block` **fails** (`true !== false`). Restored → passes.
- Force the positive return to `false` (pre-fix behaviour: every `BLOCKED` silent) →
  `a PR green for 6h45m and still BLOCKED must be flagged` **fails**
  (`false !== true`). Restored → passes.

The self-check also pins both sides of the threshold, every fail-quiet path
(unreadable checks, no green timestamp, red check), and that
`BEHIND/DIRTY/UNSTABLE/UNKNOWN/CLEAN` are never reclassified.

Live wiring smoke test against real open PRs (forcing `mergeStateStatus:"BLOCKED"`):
#3894 → transient (`pending-checks:11`), #3892 → transient (`green-only-5m`),
#3890 → suspected permanent (`green-49m-still-blocked`). The false positive the
classifier most had to avoid — a PR whose checks are merely slow — does not occur.

**What the test covers is classification, not enqueue-succeeds.** That is #3906's
experiment.

### The way this fix could silently never fire — checked, and it does not

`blockedDiagnosis()` short-circuits unless `mergeStateStatus === "BLOCKED"`, and the
live smoke test above *forced* that value. In production the app token supplies it —
and the app emits `UNKNOWN` a lot. Its own 11:51:26Z run read

```
- #3892 skip (UNKNOWN)   - #3891 skip (UNKNOWN)
- #3883 skip (UNKNOWN)   - #3877 skip (UNKNOWN)
```

while a PAT saw `BEHIND` / `UNSTABLE` / `DIRTY` / `BEHIND` for the same four. If the
target population read `UNKNOWN` at sweep time, no warning would fire and no label
would land — **indistinguishable from "no stalls today."**

**Checked against the real population, two runs ~49 minutes apart.** The app token
reported #3567 as `BLOCKED` in run `30126231181` @21:01:21Z *and* in run
`30129070114` @21:50:37Z. The stalling PR reads `BLOCKED`, stably, so the trigger
matches.

**Do not extend the classifier to `UNKNOWN`.** `UNKNOWN` is GitHub still computing
mergeability (see `reference_autoenqueue_grace0_races_mergestate_recompute`);
firing on it manufactures exactly the slow-checks false positive the two guards
exist to prevent. The `UNKNOWN` frequency is recorded here as a known limitation,
not as something to widen the classifier for.

### Options A and B — declined, with reasons

- **A (grant the app `workflows: write`) — declined, not escalated as a
  recommendation.** Its entire justification is the *reconstructed* mechanism above.
  Widening a `workflow_run`-triggered token to arbitrary CI modification — i.e.
  arbitrary code execution on runners holding repo secrets — on an unverified
  premise is a bad trade, and C does not need it.
- **B (PAT fallback in the enqueue script) — declined.** A long-lived user
  credential in repo secrets, plus a second code path whose detection logic becomes
  a security boundary, to cover a case C surfaces for free.

### Follow-up: #3906 (option G) — the one that could actually fix the class

Drop the token-relative `mergeStateStatus` pre-filter for exactly the
suspected-permanent case and let GitHub adjudicate the `enqueuePullRequest`
mutation. Filed separately because it must not ride along with C: its premise is
untested, and its half-success mode (doomed `merge_group` on a serial queue →
auto-park `hold` → permanently skipped) is **worse than today**.

## Acceptance

1. (b) — a green PR in the failing cell is surfaced within ~15 min, with a named
   warning line and a `needs-manual-enqueue` label, instead of one more
   indistinguishable `skip (BLOCKED)`. (a) is explicitly **not** claimed; see #3906.
2. Met — `skip (BLOCKED — transient (...))` vs
   `skip (BLOCKED — SUSPECTED PERMANENT (...))` are now different log lines.
3. n/a — option A was not chosen, so there is no permission widening to record.
4. Partly — the classifier is validated by kill-switch and by a live run against
   real PRs. A scratch fork-head workflow-touching PR under the app token is
   #3906's experiment; running it here would have meant shipping G untested.
