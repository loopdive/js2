---
name: reference_cross_session_issue_id_collision_renumber_loser
description: "Two concurrent Claude sessions on the shared fork frequently collide on claim-issue --allocate ids; detect via two open PRs adding the same plan/issues/<id>-*.md; the CLEAN/queued one wins, the other renumbers (the dup-id gate only fires in merge_group, so the loser silently parks)"
metadata:
  node_type: memory
  type: reference
  originSessionId: 1ef96580-7db6-4559-9e05-7f637b7f44c5
  modified: 2026-07-25T00:07:59.189Z
---

When two Claude sessions run concurrently against the shared `ttraenkler` fork ([[project_sprint64_parallel_session_dup_prs]], [[feedback_parallel_session_pr_close_conflict]]), `scripts/claim-issue.mjs --allocate` collisions are **FREQUENT** — 3× in one 2026-06-28/29 session (#2814: bugC's closure fix vs a parallel NM "re-chunk" PR; #2821: arch2818's CPS-capture spec vs a parallel "deno-stdio EPIPE flake" PR). The `--allocate` open-PR scan has a **race window**: both sessions allocate the same next id before either has pushed its PR, so neither scan sees the other.

**Symptom:** two open PRs each ADD a `plan/issues/<SAME-id>-*.md` with different slugs/content.

**Why it silently wedges:** the required `check:issue-ids:against-main` (in `quality`) only rejects ids already on **main**. At PR-open time neither dup is on main, so **both PRs go green**. The collision only fires in the **merge_group** once the first one lands and puts the id on main — then the second PR's merge_group dup-id check fails and it **auto-parks/wedges** (exactly the hand-picked-collision hazard CLAUDE.md warns about, but reached via a concurrent `--allocate` race, not hand-picking).

**Resolution — the CLEAN/queued PR wins the id; the other RENUMBERS:**
1. Whichever PR is CLEAN/already-in-the-queue lands first → it keeps the id.
2. Re-`--allocate` a fresh id for the loser (now that the winner's PR exists, the open-PR scan skips the taken id), `git mv` the issue (+ test) file, update `id:` frontmatter + heading + cross-refs + PR title, `git merge origin/main`, push. Bundle into the existing PR so it lands clean.

**A SECOND VARIANT — SELF-collision by one agent (2026-07-25).** The race is not only
cross-session. One agent filing **two issues in quick succession** got id **#3589 twice**:
`3589-static-super-property-read-class-receiver.md` (landed on main via its earlier PR) and
`3589-assert-harness-null-deref-unmasked-by-3563.md` (added by its next branch). Parked
#3581 in the merge_group on `quality` → **Issue integrity + link gate (#1616)** →
`--check FAILED: 1 duplicate IDs`. The same agent ALSO hit the cross-lane variant hours
earlier (reserved 3585; another lane landed `3585-*` on main mid-flight; renumbered to
3592). **Two collisions, one session, two different mechanisms.**

**RENUMBERING IS ITSELF A TRAP — stage the `git mv` AND the frontmatter edit together.**
A renumber commit moved the *file* 3594→3595 but left the in-file `id:` edit **unstaged**, so
the PR briefly carried filename `3595-*` with `id: 3594` — which would have re-collided and
wedged the queue **on the same gate being fixed, twice in one day**. The ONLY signal was
gh's `Warning: 1 uncommitted change` on `pr create`. **That warning is load-bearing, not
noise.** After any renumber, grep the whole change-set for the old id and confirm zero hits —
filename, `id:` frontmatter, heading, cross-refs, test names, PR title, and any
rationale/history comments in code.

**Verify the incumbent yourself with `git ls-tree origin/main`, don't take anyone's word —
including the lead's.** The lead asserted which of two same-id files was already on main and
had it exactly inverted; the agent checked the tree, found the opposite, and applied
"main wins" to the correct file anyway.

**Adopting vs force-pushing when a concurrent writer has touched your branch:** run
`git merge-base --is-ancestor <your-head> <fork-head>` FIRST. If true, `reset --hard` to
their head is safe (nothing of yours is lost); a blind force-push would silently destroy
the other actor's work.

**`--no-pr-scan` IS THE PROXIMATE CAUSE — stop using it under concurrent lanes (2026-07-25).**
One agent's BOTH collisions (3584, 3590) came from `claim-issue.mjs --allocate --no-pr-scan`;
**every full-scan allocation it made held.** The flag skips the open-PR half of the scan, which
is exactly the half that sees a parallel lane's in-flight id. It saves seconds and costs a full
CI round-trip, because the collision only surfaces in `quality` on the merged state. **Default
to the full scan; treat `--no-pr-scan` as unsafe whenever a second lane may be live.** Worth
making the PR scan the default in the script.

**So: `--allocate` one id at a time and CONFIRM each differs before writing files.** A
reservation that has not yet propagated to the `issue-assignments` ref — or an id that
lands on `main` after the scan — is invisible to the next `--allocate`. The allocator
cannot see either, by construction.

**Note the failure surfaces in TWO different gates**, so don't pattern-match on one:
`check:issue-ids:against-main` (id already on main) and the **Issue integrity + link gate
(#1616)** (two files with the same id in one tree). Both live in `quality`; both fire only
on the merged state.

**Prevent / detect early:** when you dispatch work that will `--allocate`, or before re-admitting a parked PR, check whether a parallel-session open PR already adds that `plan/issues/<id>-*.md` (`gh pr view <N> --json files`). Catch it at re-push time, not in the merge_group. Links: [[feedback_parallel_session_pr_close_conflict]], [[project_sprint64_parallel_session_dup_prs]], [[reference_subissue_filename_dupid_gate]].
