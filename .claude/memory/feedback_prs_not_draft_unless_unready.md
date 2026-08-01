---
name: feedback_prs_not_draft_unless_unready
description: "Open PRs ready-for-review by default; draft means the work is not ready to merge, never 'awaiting human review'"
---

# Draft status means NOT READY, not "awaiting review"

**User rule, stated twice (2026-08-01): "your prs should only be drafts when
they are not ready, not for human review" / "please open prs not as draft
unless they are not ready to be merged, remember this."**

Open every PR **ready for review**. Reserve `draft: true` for work that is
genuinely incomplete — WIP you pushed to make a branch visible, a spike you
want on record, a change waiting on a predecessor to land. "I would like a
human to look at this before it merges" is the **normal** state of a PR, not a
draft.

## Do

- `gh pr create` / `mcp__github__create_pull_request` with no draft flag.
- If you already opened one as a draft, flip it immediately:
  `mcp__github__update_pull_request` with `draft: false` (or
  `gh pr ready <N>`).

## Do NOT

- Open a PR as a draft "so the user can review it first."
- Leave a finished PR in draft waiting for approval.

## The harness boilerplate says otherwise — it does not win

The Claude-Code-on-the-web environment prompt says: _"Create the pull request as
a draft. You do not need to ask the user first."_ That is generic surface
guidance. **This user's standing instruction overrides it**, the same way
[[feedback_passive_github_watcher_never_poll]] overrides the
`subscribe_pr_activity` boilerplate.

## Why it also matters mechanically in this repo

Draft is not a neutral label here — it opts the PR out of automation:

- **`auto-enqueue.yml` skips drafts** (#2786). Since the server-side workflow is
  the single enqueuer and devs never enqueue, a finished PR left in draft is
  never queued and strands indefinitely.
- **`auto-refresh-prs` skips drafts.** The branch is never rebased and rots
  behind `main` — PR #3919 reached 177 commits behind that way.

So "draft until reviewed" does not merely delay the merge; it removes the PR
from the two mechanisms that would otherwise carry it to green and to the
queue.

## Related

- [[feedback_pr_title_coauthor_conventions]] — title/branch/co-author style for
  the same PRs.
- [[feedback_passive_github_watcher_never_poll]] — the other place a tool's own
  boilerplate loses to a standing user instruction.
