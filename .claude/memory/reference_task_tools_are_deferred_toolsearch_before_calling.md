---
name: reference_task_tools_are_deferred_toolsearch_before_calling
description: "Spawned agents genuinely CANNOT use TaskList/TaskUpdate — they inherit the parent's non-deferred tool set and get no ToolSearch, so agent-def `tools:` frontmatter does not govern. The LEAD must own task state."
metadata: 
  node_type: memory
  type: reference
  originSessionId: 417b718f-2c4e-4164-9782-006e2e33f7ff
  modified: 2026-07-24T21:16:42.595Z
---

**Spawned agents cannot use `TaskList`/`TaskUpdate`/`TaskCreate`. This is real, not a
discoverability problem.** Confirmed 2026-07-24 after three agents reported it
(dev-opus5-mop, dev-guard-tests, dev-rebase-3563).

**Verbatim error** (from the `TaskList` call):
```
Error: No such tool available: TaskList. TaskList exists but is not enabled in this
context. Use one of the available tools instead.
```

**Root cause — subagents inherit the PARENT session's non-deferred tool set.**
dev-rebase-3563's actual runtime set was exactly:
`Read, Edit, Write, Bash, Agent, SendMessage, advisor`.
Compare the lead's own base set — also **no `Grep`, no `Glob`, no task tools**; the lead
only obtains `TaskUpdate`/`TaskList` by calling `ToolSearch`. Subagents are **not** given
`ToolSearch`, so they can never load a deferred tool. The `tools:` frontmatter in
`.claude/agents/developer.md` (which does declare `TaskCreate, TaskUpdate, TaskList`) is
**not** what determines the spawn's runtime set.

**DO NOT tell agents to run `ToolSearch` to fix this** — they don't have that tool either.
(The lead made exactly this wrong call before collecting the verbatim error. Get the exact
error string before proposing a mechanism.)

**Operational consequence — the LEAD owns task state for every spawned agent.** Do not rely
on the documented "dev flips its own task to `completed` at enqueue time"; a spawned dev
structurally cannot. So:
- Set `owner` + `in_progress` yourself when you dispatch.
- Flip to `completed` yourself when the PR opens/merges.
- Tell agents in the spawn prompt: *"you will not have TaskList — report status to me via
  SendMessage and I will maintain the queue."* That prevents them burning turns on a tool
  they cannot call.

This makes the chronic stale-TaskList drift structural rather than a discipline failure —
see [[feedback_tasklist_sync_unreliable]] and `scripts/reconcile-tasklist.mjs`.

**Related trap:** `reconcile-tasklist.mjs` matches by PR-title grep, so it **over-reports on
multi-slice umbrella issues** — it flagged #3024 as "fixed by merged PR" when the merged PR
was a *sibling slice* (#3558) with a different error signature entirely, and #3563's real
work was still unlanded. Always verify a reconciler "already done" claim against the actual
diff before closing anything ([[feedback_measure_never_extrapolate]]).
