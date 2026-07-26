---
name: reference_never_push_to_a_queued_pr_it_ejects_to_the_back
description: Pushing ANYTHING to a PR already in the merge queue ejects it; auto-enqueue re-adds it at the BACK. A queued PR never needs a manual main merge.
metadata: 
  node_type: memory
  type: reference
  originSessionId: 417b718f-2c4e-4164-9782-006e2e33f7ff
  modified: 2026-07-25T23:51:48.714Z
---

**Once a PR is IN the merge queue, do not push to its branch — not even a
harmless `git merge origin/main`.** The push ejects it from the queue, and
`auto-enqueue` re-adds it at the **BACK**, behind everything that has since
entered.

**A queued PR does not need a manual main merge.** The queue builds each entry
against main's tip by design. `CLEAN | MERGEABLE` while queued is the healthy
state — do NOT "helpfully" refresh it.

**This directly contradicts the normal remedy**, which is why it bites: for an
UNQUEUED PR, `git merge origin/main` + push is the correct fix for `BEHIND` and
for re-triggering checks. The instruction flips the moment the PR is queued.
**Check queue membership BEFORE advising or performing a push.** (2026-07-26: the
lead told a shepherd to merge-and-push a PR that was by then queued at position 6;
obeying would have dropped it behind the very PR it was supposed to land ahead of.
The shepherd refused and was right.)

**Why the ordering can matter enormously:** this repo's queue is configured
`maximumEntriesToBuild: 1`, `maximumEntriesToMerge: 1` — **one entry per merge
group, one push to main per PR, no batching.** So a PR carrying a CI/gate FIX can
never protect a PR ahead of it in the queue; each earlier entry gets its own push
validated against main's code as it stands *without* the fix. Sequencing is
load-bearing, not cosmetic.

**If a queued PR genuinely must change**, accept that it goes to the back, and say
so explicitly when recommending it.

See [[reference_autoenqueue_grace0_races_mergestate_recompute]] and
[[reference_workflow_touching_prs_never_autoenqueue]].
