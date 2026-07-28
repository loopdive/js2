---
name: reference_admin_merge_active_queue_conflict_not_orphan
description: Admin-merging while the merge queue is active can conflict (harmless) but does NOT orphan/lose the commit — and a single git-fetch snapshot mid-propagation can falsely look like loss
metadata: 
  node_type: memory
  type: reference
  originSessionId: 00d53514-a026-4121-9d65-d0a8c54ba5a5
  modified: 2026-07-19T15:00:47.508Z
---

Admin-merging (`gh pr merge <N> --admin --merge`) while the merge queue has
active entries is risky but does **NOT lose work**. Two real effects observed
2026-07-19 (do not over-react to either):

1. **Conflict / DIRTY (harmless).** #3409's admin-merge failed outright with
   "Pull Request has merge conflicts" because main had advanced past its base.
   Effect: the PR just goes DIRTY. Catch it up (`git merge origin/main`) and
   retry — nothing is lost.

2. **False "orphan" from fetch timing.** #3406's admin-merge SUCCEEDED, but for
   a few minutes a single `git fetch origin main` + `git log origin/main`
   showed main's tip at `8ae1591ac` with #3406's merge commit `8d7176576` (and
   the test file it added) apparently ABSENT — I wrongly concluded it was
   orphaned/lost and even wrote a memory saying so. It was a **fetch-timing
   artifact**: the queue was mid-propagation (#3306, #3406, #3308 were still
   settling). Minutes later main advanced `8ae1591ac → 8ca52342d(#3306) →
   8d7176576(#3406) → e4701ebbc(#3308)` and #3406 was fully present, empty diff
   vs its branch.

**Rules:**
- **Never declare a commit orphaned/lost from ONE `git log origin/main`
  snapshot during active queue merges.** Re-fetch and re-check `git merge-base
  --is-ancestor <sha> origin/main` (with the FULL sha) after the queue settles
  before concluding anything. The merge queue is append-only; it re-lands, it
  doesn't drop.
- Admin-merge during an active queue at worst **conflicts** (harmless DIRTY) or
  lands **slightly reordered** — it does not lose work.
- Still prefer **fixing the gate** (net-aware gate #3457) over admin-merge for a
  net-positive PR the ratio gate over-parks — cleaner, no reordering, merges via
  the queue normally. See [[project_merge_queue_requeue_cancels_run]] for the
  separate re-enqueue-loop hazard.
