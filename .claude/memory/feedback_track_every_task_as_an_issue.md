---
name: feedback_track_every_task_as_an_issue
description: Every task worked on must have an issue filed or updated — not only defects, and not only at the end
metadata:
  node_type: memory
  type: feedback
---

**User instruction, 2026-08-19: "Remember to always file or update issues for
the tasks you work on so it's tracked."**

Broader than
[file-defects-as-issue-markdown](feedback_file_defects_as_issue_markdown_not_tasklist.md),
which covers *defects and findings*. This one covers **work**: if you are doing
it, an issue says so.

## The rule

Before or while working a task — not after — either:

- **update** the existing issue (`status: in-progress`, and record decisions or
  scope changes as they are made), or
- **file** a new one via `claim-issue.mjs --allocate` (never hand-pick an id).

Applies to work that arrives as conversation, not just work pulled off the
TaskList. A project-lead decision in chat ("write our own allocator", "the
trigger is eval-reachable") is a task; it needs an issue or an edit to one, in
the same change that acts on it.

## What went wrong without it (2026-08-19)

In one session:

- A **project-lead decision** to invert allocator ownership was dispatched to a
  subagent with a detailed brief and **no issue at all**. The brief was the only
  record, and a brief dies with the agent. Filed retroactively as #4557.
- `check:linear-ir` was found **red on clean `main`** (IR-compiled 8 → 6),
  confirmed against a fresh `origin/main` worktree, and **reported to the user
  three separate times across the session without ever being filed**. Each
  mention read as new information because nothing held it. Filed as #4558.

Both were *known*, *verified*, and *untracked* — the worst combination, because
the work of finding them was already paid for and then thrown away.

## Why chat is not tracking

A decision stated in conversation is invisible to: the TaskList sync, the
pre-dispatch gate, `budget-status --pick`, and every future session. The issue
file is the only artifact any of those read. "The user knows, I know, and it's
in the transcript" is not tracked — it is remembered, and only until the
context window rolls.

## Corollary

When a decision *changes* an existing design, edit the issue **and** the ADR in
the same change, rather than letting the newer decision live only in the commit
message. See ADR-0020's Corrections section for the shape.
