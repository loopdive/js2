---
name: feedback_file_defects_as_issue_markdown_not_tasklist
description: Every defect/finding MUST be filed as a markdown file in plan/issues/<id>-<slug>.md — a TaskList entry is NOT a filing and does not survive the session
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 31a336a9-7fce-4c41-9a15-3e10d02eca44
  modified: 2026-08-01T18:49:33.818Z
---

**User instruction, 2026-08-01: "remember to always file them in plan/issues as
markdown files."**

Given after the lead reported having "filed" eight defects that were only
**TaskList entries**.

**Why:** the TaskList lives in `~/.claude/tasks/{<session-uuid>,js2wasm}/*.json`
— session/team state, **not the repo**. Issue files under
`plan/issues/<id>-<slug>.md` are the **source of truth**; the TaskList is
auto-synced *from* them by `scripts/sync-current-tasklist.mjs`. So:

- A TaskList-only "filing" **dies with the session**. The defect ends up
  recorded nowhere in the repo, and the next agent re-derives it from scratch —
  or never finds it.
- Task state and issue state are **separate stores that drift silently**. A task
  marked done does not make an issue done, and vice versa.

**How to apply — every time a defect, refutation, or unowned finding is
identified:**

1. `export GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL`
   first — `claim-issue.mjs` exits **6** with "Author identity unknown"
   otherwise, and a worktree-local `git config user.email` is NOT enough.
2. `CLAIM_ASSIGN_REMOTE=upstream node scripts/claim-issue.mjs --allocate --by ttraenkler/<agent>`
   — `upstream` is mandatory; the default `origin` is the **fork**, whose `main`
   diverges, which is the root cause of the 6 live id collisions in this repo.
   Never hand-pick an id.
3. Write `plan/issues/<id>-<slug>.md`. **Filename prefix and frontmatter `id:`
   must agree** or the integrity gate rejects the PR.
4. Land it. **Docs-only changes go in ONE open PR** — check
   `gh pr list -R loopdive/js2wasm --state open` before opening a second.
5. A TaskList entry is optional *scheduling* on top; it is never the filing.

**Do not reserve an id you may not use** — an abandoned reservation leaves a
permanent hole (#3890/#3891 were burned that way). Allocate at the moment you
write the file.

Related: [[feedback_issue_completion]], [[feedback_document_findings]],
[[feedback_bare_numbers_are_plan_tasks]],
[[reference_issue_id_collides_while_pr_is_open]].
