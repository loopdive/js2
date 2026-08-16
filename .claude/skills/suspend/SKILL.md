---
name: suspend
description: Suspend ALL in-flight team work durably — snapshot every agent worktree, write a ## Suspended Work handoff into each lane's issue file, push every lane branch, open one DRAFT PR per lane with the handoff in the description, and disarm the loop's timers. Run before a planned stop, container teardown, or long pause. Resume is a fresh agent per lane reading the issue file's handoff.
---

# /suspend — suspend the standing team with durable handoffs

Everything in-flight becomes: a pushed branch + a draft PR whose description
is the handoff + a `## Suspended Work` section in the lane's issue file. A
resumer needs NOTHING from this session's memory — worktrees, transcripts,
and timers are all treated as already lost.

Run the phases in order. Phase 1 is time-critical (agents may be mid-write);
everything after is durable bookkeeping.

## Phase 1 — freeze and snapshot (do this FIRST, before any messaging)

1. `ListAgents` — inventory running agents. For each, note its worktree path
   (`/home/user/js2wasm/.claude/worktrees/agent-<id>` or from its spawn
   record) and its ISSUE id.
2. For each agent worktree — **snapshot before talking to anyone**:
   ```bash
   cd <worktree> && git add -A && \
   git -c user.name="Thomas Tränkler" -c user.email=git@thomas.traenkler.com \
     commit --no-verify -m "wip(#<issue>): suspension snapshot ✓"
   ```
   - `--no-verify` is sanctioned for WIP snapshots (CI runs the real gates on
     the eventual real PR).
   - **The commit lands on the worktree's CHECKED-OUT branch** (verify with
     `git branch --show-current`), NOT necessarily the harness's
     `worktree-agent-<id>` ref — record the actual branch name; a resumer
     given the wrong ref finds plain main (this burned a lane on
     2026-08-16, see #4484's record).
   - An empty snapshot (nothing to commit) is fine — note "clean tree at
     <sha>".
3. Only now message each agent (SendMessage): "SUSPEND — stop work; your
   worktree was snapshot at <sha> on <branch>; do not commit further." Do
   not wait for acknowledgments; killed or busy agents are already covered
   by the snapshot.

## Phase 2 — handoff into the issue files

For each lane (running agents AND merged-but-unshipped lanes), append to
`plan/issues/<id>-<slug>.md`:

```markdown
## Suspended Work (<UTC timestamp>)

- **Branch**: <branch> at <sha> (pushed to origin)
- **Worktree at suspension**: <path> (treat as gone; the branch is the truth)
- **State**: <one of: implementation complete + verification pending /
  mid-implementation, last verified step X / snapshot unverified — may not
  typecheck>
- **Verified so far** (runs the AGENT executed, with numbers): <...>
- **NOT yet verified / next steps in order**: <...>
- **Traps for the resumer**: <base predates waves X/Y — do not rebase, the
  lead reconciles at merge; tier-sensitive pins need
  `build-runtime-eval-provider.mjs --refusal-only`; etc.>
```

The frontmatter keeps its real status (`in-progress`, never `done` for
unverified work). Commit these edits to the SESSION branch (they are docs;
normal signed-committer commit, ✓ token).

## Phase 3 — push everything

1. Push each lane branch: `git push --no-verify origin <lane-branch>`.
2. Push the session branch (carries the issue-file handoffs + any
   already-merged-but-unshipped lane work).
3. Nothing local may remain that a resumer would need — verify with
   `git log origin/<branch>..<branch>` empty for every branch touched.

## Phase 4 — one DRAFT PR per lane

For each lane branch with commits beyond main, open a **draft** PR
(`-R loopdive/js2wasm`, base `main`), titled
`WIP(#<id>): <issue title, short> — SUSPENDED`, whose description IS the
handoff (copy the `## Suspended Work` section verbatim, plus the lane's
verified-numbers table if one exists). Append the standard CLA section and
attribution footer.

- **Draft is the suspension mechanism**: drafts are never auto-enqueued and
  `auto-refresh-prs` skips them — the PR will NOT be rebased or merged while
  suspended. That is intended; note in the description that the resumer
  should expect the branch to be behind main.
- Work already merged into the SESSION branch but not yet PR'd gets ONE
  normal (non-draft) wave PR if it is fully verified, or rides a draft PR
  from the session branch if not — verified work should ship, not sleep.
- Subscribe to nothing. A suspended PR intentionally has no watcher.

## Phase 5 — disarm the loop

1. `list_triggers` → delete every pending self check-in
   (`send_later`/Routine) this session armed. A firing check-in against a
   suspended team would respawn agents against stale state.
2. If a goal Stop hook is active, leave it — suspension is a state, not goal
   completion; the user clears the goal or resumes.
3. Final message: a suspension manifest — per lane: issue id + title, branch
   + sha, draft-PR URL, state line, and the single next action for a
   resumer. Include the current ES≤5 tally and the residual queue order.

## Resume (for whoever picks it back up)

Per lane: spawn a fresh agent whose prompt is two pointers — the campaign
brief (`plan/method/es5-standalone-agent-brief.md`) and the issue file
(whose `## Suspended Work` section is the handoff) — plus "merge
<lane-branch>, establish green typecheck, re-verify everything the handoff
lists as unverified with your own runs." Mark the draft PR ready-for-review
only after the lane's verification floor is met on a current base.
