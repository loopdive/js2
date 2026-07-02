---
name: feedback_dispatch_promotes_sprint_current
description: "When dispatching an issue to a dev, promote its frontmatter to sprint:current + status:in-progress at dispatch time, not at PR-merge time"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 1ef96580-7db6-4559-9e05-7f637b7f44c5
---

When you dispatch an issue to a dev agent (spawn/assign on it), immediately promote its frontmatter to `sprint: current` + `status: in-progress`. Do NOT defer the promotion to the dev's implementation PR.

**Why:** the live TaskList is auto-synced from `sprint: current` issues (#2751 budget-window model, `scripts/sync-current-tasklist.mjs`). If in-flight work stays `sprint: Backlog`/`<N>` + `status: ready`, then (a) the TaskList / budget-window under-counts active work, and (b) the sync re-lists it as **claimable** → a second agent (or the auto-dispatcher) double-claims work already in flight. The user flagged this directly: hand-dispatched #1627 (Backlog), #2740/#2745 (sprint:67) were left untagged while being worked — fixed via chore PR #2206.

**How to apply:** at dispatch, batch the sprint+status promotion into a small chore PR (direct push to `main` is branch-protected — must go through a PR). The dev may also set status in its own PR; identical `sprint:`/`status:` line edits merge cleanly on the dev's next `git merge origin/main`. The team-store TaskList itself is fine — the sync only ever creates tasks from `sprint: current`; the gap is issues you dispatch *outside* the synced set. See [[feedback_dispatch_status]] and [[feedback_tasklist_always_populated]].
