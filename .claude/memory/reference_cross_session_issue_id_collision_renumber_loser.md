---
name: reference_cross_session_issue_id_collision_renumber_loser
description: "Two concurrent Claude sessions on the shared fork frequently collide on claim-issue --allocate ids; detect via two open PRs adding the same plan/issues/<id>-*.md; the CLEAN/queued one wins, the other renumbers (the dup-id gate only fires in merge_group, so the loser silently parks)"
metadata:
  node_type: memory
  type: reference
  originSessionId: 1ef96580-7db6-4559-9e05-7f637b7f44c5
---

When two Claude sessions run concurrently against the shared `ttraenkler` fork ([[project_sprint64_parallel_session_dup_prs]], [[feedback_parallel_session_pr_close_conflict]]), `scripts/claim-issue.mjs --allocate` collisions are **FREQUENT** — 3× in one 2026-06-28/29 session (#2814: bugC's closure fix vs a parallel NM "re-chunk" PR; #2821: arch2818's CPS-capture spec vs a parallel "deno-stdio EPIPE flake" PR). The `--allocate` open-PR scan has a **race window**: both sessions allocate the same next id before either has pushed its PR, so neither scan sees the other.

**Symptom:** two open PRs each ADD a `plan/issues/<SAME-id>-*.md` with different slugs/content.

**Why it silently wedges:** the required `check:issue-ids:against-main` (in `quality`) only rejects ids already on **main**. At PR-open time neither dup is on main, so **both PRs go green**. The collision only fires in the **merge_group** once the first one lands and puts the id on main — then the second PR's merge_group dup-id check fails and it **auto-parks/wedges** (exactly the hand-picked-collision hazard CLAUDE.md warns about, but reached via a concurrent `--allocate` race, not hand-picking).

**Resolution — the CLEAN/queued PR wins the id; the other RENUMBERS:**
1. Whichever PR is CLEAN/already-in-the-queue lands first → it keeps the id.
2. Re-`--allocate` a fresh id for the loser (now that the winner's PR exists, the open-PR scan skips the taken id), `git mv` the issue (+ test) file, update `id:` frontmatter + heading + cross-refs + PR title, `git merge origin/main`, push. Bundle into the existing PR so it lands clean.

**Prevent / detect early:** when you dispatch work that will `--allocate`, or before re-admitting a parked PR, check whether a parallel-session open PR already adds that `plan/issues/<id>-*.md` (`gh pr view <N> --json files`). Catch it at re-push time, not in the merge_group. Links: [[feedback_parallel_session_pr_close_conflict]], [[project_sprint64_parallel_session_dup_prs]], [[reference_subissue_filename_dupid_gate]].
