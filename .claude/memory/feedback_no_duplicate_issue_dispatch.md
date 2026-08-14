---
name: feedback_no_duplicate_issue_dispatch
description: "Before dispatching/coding any sprint issue, verify it isn't already on upstream/main or fixed by an open PR in review"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 9b7877fc-6699-40e1-b5cf-8f2f65bfd493
---

Never dispatch or implement a sprint issue/slice without first confirming
it is NOT already (a) fixed on **upstream/main** (loopdive/js2wasm), or (b)
covered by an **open PR in review**. The stakeholder called this out
explicitly during sprint 63.

**Why this keeps happening here:** the fork `origin/main` runs hundreds of
commits behind `upstream/main`, so issues that LOOK open against the fork
are often already merged upstream; and the multi-session swarm opens
overlapping PRs (e.g. #2162/#2166 slices were redone from stale worktrees;
#1634/#1635 were duplicate Set.forEach PRs). Issue frontmatter `status:`
also lags reality.

**How to apply — gate on every task before coding:**
1. `git fetch upstream` and base/validate against `upstream/main`, never
   the stale `origin/main`. See [[feedback_merge_queue_wedge_recovery]] for
   the fork-vs-upstream topology.
2. Re-run the issue's repro on upstream/main — if it no longer fails, the
   issue is already fixed; mark it done, don't code.
3. `gh pr list -R loopdive/js2wasm --state open --search "#<id> in:title"` (and
   grep titles) — if a PR already implements the slice, do NOT open a
   duplicate; coordinate or pick a different residual slice.
4. Bake "RE-VALIDATE vs upstream + check open PRs first" into every
   TaskList task description so the dev self-gates.

This is the single biggest source of wasted agent/budget effort in this
project. Prefer one validated slice over three speculative duplicates.

**Intra-fleet lane collision (sprint 63→64, 2026-06-19).** A distinct,
nastier variant: two of MY OWN concurrent agents self-claim the SAME bug —
the `gh pr list` gate above does NOT catch it because neither dup PR exists
yet when each starts coding. It bit twice in one session mining the broad
`invalid Wasm binary ~1641` cluster: ctorval self-claimed #70 (any[].join)
already in arrayrep's warm lane; then protoglue ALSO implemented the same
any[].join fix → arrayrep #1753 and protoglue #1754 were duplicate PRs
(identical compileArrayJoinNative `__extern_toString` fix), one had to be
closed. **Root cause:** I let agents self-direct into a shared broad cluster
with no partition. **Fix — partition the cluster into explicit
non-overlapping LANES, one per agent, before they self-direct:** e.g. for
the invalid-Wasm cluster — arrayrep = array ELEMENT-REP (sort/join/toString/
find over boxed-any elements), ctorval = array-like RECEIVER dispatch
(#1461), protoglue = NON-array (object/closure/string/coercion) codegen.
State each lane's boundary AND the adjacent lanes it must NOT touch. When an
agent flags a finding outside its lane, route it to the lane owner, don't let
the finder grab it. Also: have agents announce a self-directed claim (a one-
line "claiming X" before coding) so collisions surface pre-PR, not at the
merge queue. See [[feedback_no_shared_worktree_assignment]].
