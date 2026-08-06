---
name: feedback_confirm_author_is_done_before_shepherding_their_pr
description: "Before handing someone's PR to a shepherd, confirm the AUTHOR is finished — not merely that a PR exists. 'PR open + CI running' is the middle of the author's loop, and dispatching there causes a duplicate implementation."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 31a336a9-7fce-4c41-9a15-3e10d02eca44
  modified: 2026-08-02T01:32:33.080Z
---

**Measured 2026-08-02.** The lead read an agent's status — *"PR open, CI
running, local verification being re-run solo"* — as **finished**, and
dispatched a shepherd with "the work is finished; do NOT redo the work, drive it
to CLEAN."

It was not finished. The author was mid-fix on the **same two blockers**. Both
implemented the same LOC-ratchet extraction. The author pushed first; the
shepherd's push was correctly rejected non-fast-forward (it did **not**
force-push). Cost: one full duplicate implementation.

## Why the existing safeguards could not catch it

The `pre-dispatch-gate` blind spot is *"started but not yet claimed or pushed"*,
and the standing mitigation is **claim at dispatch time**. **That does not cover
shepherd dispatch** — the issue is *already claimed*, by the very agent still
working on it. Nothing in `main`, open PRs, or the claim ref showed a conflict,
because the author's newer commits simply had not been pushed yet.

## The missing check is LIVENESS, not ownership

**And SILENCE CANNOT BE THE DISCRIMINATOR** — this is the sharp version, from
the shepherd that got burned:

> "PR open + CI running" is not merely the middle of the author's loop; it is
> **indistinguishable from the end of it from outside**, because a healthy
> CI-waiting dev is *deliberately silent* — that is its documented protocol.

So "the author has gone quiet" proves nothing: quiet is the expected state both
when it is waiting and when it is done.

**The cheap discriminator that would have caught it — use this:**

1. **Compare the PR head sha against the author's last report.** A head carrying
   commits the author never mentioned is live work. A head unchanged since its
   last message is genuinely parked. *(In the 2026-08-02 case the head moved
   FIVE times while the shepherd worked.)*
2. **Check branch push recency.** Pushed minutes ago ⇒ still working.
3. **An explicit handoff is the only positive signal**: "I am at the end of my
   budget", "handing off". Absent that, assume it is still working. A completion
   notification counts; an interim progress report does not.

A clean handoff is the case shepherding is **for**. That exact case worked
perfectly the same day on a different PR, dispatched off an explicit
"I am out of budget, it needs one merge + push".

A clean handoff (*"I am out of budget, it needs one merge + push"*) is the case
shepherding is **for**. That one worked perfectly the same day on a different
PR.

## When it happens anyway

The shepherd's behaviour here was exactly right and is the pattern to repeat:
**stop the line, report before doing anything else, never force-push over a
non-fast-forward rejection.** A non-fast-forward rejection is the safeguard
working — treat it as a signal to investigate, never as an obstacle to
`--force` past.

And **do not discard the duplicate work**: if the second implementation is
better on some axis (here it retired a `loc-budget-allow` entirely rather than
granting one), land the green one and queue the better one as a **follow-up
refactor**, not a rescue. Push the branch unmerged so worktree cleanup cannot
eat it.

Related: [[feedback_no_duplicate_issue_dispatch]],
[[feedback_mandatory_predispatch_gate_and_lane_partition]],
[[reference_merge_queue_snapshots_head_at_enqueue_time]],
[[feedback_dev_silence_protocol]].
