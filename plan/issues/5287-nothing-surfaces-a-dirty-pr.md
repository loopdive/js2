---
id: 5287
title: "A PR that goes DIRTY is invisible — no label, no comment, and automation cannot recover it"
status: ready
created: 2026-09-03
updated: 2026-09-03
sprint: current
priority: high
horizon: s
feasibility: medium
area: ci
goal: dogfood
requested_by: ttraenkler/fable-ir-takeover
related: [2547, 3878, 5275]
---

## Problem

The repo has automation for every merge-blocking state **except the one that
automation cannot fix by itself**:

| state | who notices | who fixes it |
| --- | --- | --- |
| `merge_group` failure | `auto-park` (#2547) — adds `hold` + a comment naming the run | a human, with a signal to act on |
| `BEHIND` | `auto-refresh-prs` | itself, by rebasing |
| `UNSTABLE` | nothing, but the red check is visible on the PR | a human |
| **`DIRTY`** | **nothing at all** | **only a human or an agent — a rebase would conflict** |

A PR that goes `DIRTY` gets **no label, no comment, and no check-run change**.
`auto-enqueue` takes only `{CLEAN, HAS_HOOKS}`, so it is skipped silently. The
only evidence is `mergeable_state`, a field nothing in the UI or the workflows
surfaces, and which even `GET /commits/{sha}/status` does not report — that
endpoint returns commit *statuses*, so a `DIRTY` PR whose `cla-check` passed
reads as "one check, success".

**This is the state automation is least able to clear and least able to report.**
`auto-refresh-prs` can rebase a `BEHIND` PR; it cannot resolve a conflict. So
`DIRTY` is terminal for the machinery: once a PR rots there it stays rotted
until a person touches it, with nothing anywhere saying so.

## Evidence — measured 2026-09-03 03:35, one sweep of every open PR

**Six of ten open PRs were `dirty`. One was `clean`.**

| PR | state | how long | cost |
| --- | --- | --- | --- |
| #5506 | `dirty` | since ~00:12 (**3.5 h**) | it is the **null-proto-super flake fix**. Until it lands every PR in the queue is exposed to a fifth instance of the signature that already parked four (#5479, #5480, #5486, #5498). One `add/add` conflict on a docs file — trivial, and invisible. |
| #5504 | `dirty` | since ~22:16 (**5 h**) | R6 F3-S2, reviewed **release**, blocked only on conflicts |
| #5509 | `dirty` | ~1 h | found only because its author went looking for an unrelated reason |
| #5390, #5397, #5400 | `dirty` | days | non-mergeable checkpoints — harmless, but indistinguishable from the three above |
| #5063 | `dirty` + `hold` | days | deliberate |
| #5393, #5503 | `behind` | hours | #5503 is the npm-compat artifact PR; a stalled refresh is how that dashboard **shipped stale twice in one day** |

None of the six carried a label or comment saying it was un-mergeable. Two of
them represented finished, reviewed work that simply stopped moving.

**The secondary harm is misdiagnosis.** Because `DIRTY` presents as "nothing is
happening", it invites wrong explanations. In this session it was first
attributed to CI starvation from frequent pushes — a plausible story that
produced exactly the wrong remedy (freeze the branch) for a state whose remedy
is the opposite (merge `main` in and push).

## Acceptance criteria

1. A PR that transitions to `DIRTY` gets a **label** and **one** comment naming
   the conflicting paths, within one workflow-run of the transition.
2. The comment states what to do — `git merge origin/main` (never rebase; public
   history is append-only) — and names the files, so the owner does not spend a
   turn rediscovering them. `git merge-tree --write-tree <base> <head>` produces
   the list without checking anything out.
3. **Exactly one comment per dirty episode.** A PR that goes clean and dirty
   again gets a second one; a PR that stays dirty does not accumulate. This is
   the failure mode that makes bots ignorable.
4. The label is **removed automatically** when the PR returns to a mergeable
   state, so it cannot become the stale-flag problem it is fixing.
5. It does **not** attempt to resolve anything. Conflict resolution stays with a
   human or a dispatched lane — see the CLAUDE.md rule routing `src/**` conflicts
   to a senior developer.

## Implementation Plan

**Model it on `auto-park` (#2547), which already solves the same shape** — an
un-actionable state made actionable by a label plus one explanatory comment.
Reuse its labelling and comment-idempotency logic rather than inventing a second
convention; `.github/workflows/auto-park-merge-group-failures.yml` is the
template.

1. **Trigger.** `pull_request` on `synchronize`/`reopened` catches the PR's own
   pushes but **not** the common case, which is *main* advancing underneath a
   quiet PR. Add a `push` trigger on `main` that sweeps open PRs, plus a modest
   cron as a backstop. Do **not** put this on a schedule alone — the 3.5 h
   exposure above is exactly the gap a cron-only design leaves.
2. **Detection.** `mergeable` is computed lazily by GitHub and returns `null`
   while it is being computed — poll with backoff and treat `null` as "unknown,
   retry", never as "clean". This is the single most likely bug in a first cut.
3. **Path list.** `git merge-tree --write-tree origin/main <head>` and parse the
   `CONFLICT (...)` lines. Distinguish `src/**` (route to senior-dev per
   CLAUDE.md) from docs-only conflicts (the owner can resolve) and say which in
   the comment — that distinction is what makes the comment actionable rather
   than merely informative.
4. **Label lifecycle.** Add on entry, remove on exit. Removal must be driven by
   the same sweep, not by the PR author remembering.

**Do not** make the label block `auto-enqueue`: a `DIRTY` PR is already skipped
by `mergeStateStatus`, and adding a second, label-based reason would create the
stranding hazard CLAUDE.md documents for `hold` (a wrongly-held PR strands until
someone notices).

**Sizing.** One workflow plus a small script; no source change. `horizon: s`.
The risk is comment spam, which criterion 3 exists to bound.

## Notes

The general shape, and why this is worth a gate rather than vigilance: **the
states a system reports are the states people look for.** `auto-park` exists
because a merge_group failure was invisible; this is the same lesson one rung
lower, and the sweep that found it took a single API call per PR — it had simply
never been run, because nothing prompts anyone to run it.
