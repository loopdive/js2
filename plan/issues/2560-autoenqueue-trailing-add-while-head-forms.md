---
id: 2560
title: "Auto-enqueue: append trailing green PRs while a head forms (don't skip the whole sweep)"
status: done
sprint: 64
created: 2026-06-20
completed: 2026-06-20
priority: high
feasibility: low
task_type: infrastructure
area: tooling
language_feature: n/a
goal: correctness
related: [2549, 2550, 1758]
assignee: "ttraenkler/dev-backoff"
---

# #2560 — auto-enqueue must keep feeding the queue while a head is forming

## Problem

`scripts/enqueue-green-prs.mjs` had an over-broad back-off (GUARD 1): if ANY
merge-queue entry was `AWAITING_CHECKS` ("a head is forming"), it logged
`BACK OFF … Skipping sweep this cycle.` and `process.exit(0)` — skipping the
ENTIRE sweep. Because the merge queue is SERIAL (`max_entries_to_build=1`), it
almost always has a forming head, so auto-enqueue almost never added waiting
green PRs. They stranded unqueued until a human enqueued them — defeating the
purpose of the backstop.

## Root cause / why the back-off existed

The original wedge (#1758, `project_merge_queue_requeue_cancels_run`) was caused
by **dequeuing or re-adding the HEAD** of a forming merge group: any membership
change to a forming group makes GitHub rebuild it and cancels its in-flight
`merge_group` run, which stuck the queue at `AWAITING_CHECKS` with no run. The
back-off was a blunt fix: don't sweep at all while a head forms.

But the sweep only ever enqueues PRs that are **not already in the queue** (the
`already-queued` skip covers every entry — forming head OR stable — since the
queue snapshot lists them all). So every enqueue is a **TRAILING APPEND** to the
queue tail, which leaves the forming head's merge group untouched and does NOT
cancel its run. The whole-sweep skip was therefore unnecessary for safety and
harmful for throughput.

## Fix

- Removed the `process.exit(0)` whole-sweep back-off. When a head is forming we
  now log it for visibility and **proceed** to append trailing green PRs.
- Encoded the safety invariant as a pure, exported helper
  `isTrailingAddCandidate(prNumber, queued)` (returns false for any PR already in
  the queue) and routed the loop's `already-queued` skip through it, so the
  forming head — and every other queued entry — is never re-touched.
- Kept ALL other guards unchanged: author-trust gate (`isTrustedAuthor`,
  #2549/#2550), all-checks-green, grace window, hold/draft/ENQUEUEABLE filters,
  cla-check stale-SHA rerun, BEHIND auto-update opt-in, draft-rot nudge.
- Updated the script header + `.github/workflows/auto-enqueue.yml` header to
  describe the trailing-add reasoning (trailing append safe vs head churn unsafe),
  referencing #1758.

## Acceptance criteria

- A green, unqueued, trusted PR is enqueued even while another PR's merge group is
  forming. ✓ (invariant: `isTrailingAddCandidate(green, queued)` is true)
- The forming head and any stable queued entry are never re-enqueued. ✓
- Import of the script remains side-effect-free (no `gh` calls on import). ✓

## Test Results

`tests/issue-2560-autoenqueue-trailing-add.test.ts` (5 tests) +
`tests/issue-2550-trust-gate-fork-allowlist.test.ts` (13 tests) — all 18 pass.
`node --check` clean; importing the module makes no `gh` call.
