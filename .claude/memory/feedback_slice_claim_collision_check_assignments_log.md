---
name: feedback_slice_claim_collision_check_assignments_log
description: "Slice-granular claims (id:slice) can double-dispatch; verify sole ownership in the issue-assignments log before committing, and watch for foreign edits in your worktree"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 54c1df0f-04d4-4026-b675-77fe695fb95c
---

On 2026-06-21, #2042:s4-validate-apply was claimed by BOTH sdev-reflect and
sdev-validate (issue-assignments log showed two `claim #2042:s4-validate-apply`
commits, mine then theirs). The other agent was editing MY worktree LIVE —
`src/codegen/object-ops.ts` + `src/emit/binary.ts` appeared modified mid-session
and a debug block reverted itself between two of my `git status` checks. The
claim lock did not prevent the second claim (slice-granular `id:slice` keys may
not lock the same way bare `id` does), and worktree isolation did not prevent the
other agent writing into my path.

**Why:** slice-suffixed claims (`2042:s4-validate-apply`) and a shared worktree
path let two agents land on the same work concurrently — the #1 cause of
merge-queue dups and clobbered commits.

**How to apply:**
- Before `git add`/commit, run `git status` and treat ANY tracked file you did
  NOT edit (foreign mtimes, debug instrumentation) as a collision signal — do not
  stage or commit it as your own.
- Verify sole ownership: `git log origin/issue-assignments` for your slice key;
  if another agent's claim is newer, STOP and escalate to the tech lead rather
  than racing to enqueue.
- Keep your edits to a disjoint file set from any concurrent agent (here:
  `object-runtime.ts` runtime-helper layer vs `object-ops.ts` call-site layer) so
  the two slices can ship as separate small PRs without clobbering.
- Re-claim with `--force` only when you OWN the resume; never to override a live
  peer. See [[feedback_no_shared_worktree_assignment]],
  [[feedback_no_duplicate_issue_dispatch]],
  [[feedback_shared_worktree_clobber_check_claim_first]].
