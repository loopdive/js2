---
name: feedback_resume_agents_killed_by_session_limit
description: "An agent killed by a session/rate limit is RESUMABLE — SendMessage to its name continues it with its transcript intact. Never respawn fresh and throw away its context."
metadata:
  node_type: memory
  type: feedback
  originSessionId: 003c07aa-a2eb-5278-b5b1-6c63a0be18a6
---

**When a subagent dies from a session limit, API error, or other transient —
RESUME it. Do not respawn a fresh one.**

`SendMessage` to the agent's **name** (or raw `agentId`) continues it *from its
existing transcript*. The task-completion notification says so explicitly:

> "The user can send it another message and resume it, so the same task-id may
> notify more than once."

A fresh `Agent` call starts from zero. Everything the dead agent learned —
its measured baseline, its probe inventory, the dead ends it already ruled out,
its half-formed diagnosis — is thrown away, and it re-derives all of it on the
user's tokens.

## What this cost, 2026-08-06

Two lanes (W3 runtime-eval-ternary, W4 prototype-chain-followups) were killed
mid-task by "You've hit your session limit · resets 1pm (UTC)". I preserved
W4's 574 uncommitted lines as a WIP commit and wrote a long handoff brief — then
planned to **respawn both from scratch** when capacity returned. The user had to
point out that they were still resumable.

The preservation work was not wrong, but it was solving the wrong problem: I
treated a *paused* agent as a *dead* one.

## The rule

1. Agent stops on a transient (session limit, API error, connection closed).
2. **First** check whether the work is resumable — it almost always is.
3. `SendMessage({to: "<agent-name>", message: "…resume; here is what changed
   while you were paused…"})`. Include anything that moved underneath it
   (merges to main, other lanes' findings), because it has been asleep.
4. Only spawn fresh if the task itself has genuinely changed, or the agent's
   own conclusion was that its lever was mis-scoped.

Still worth doing alongside a resume: **commit and push any uncommitted work in
the agent's worktree**, because worktrees are reclaimed and an unpushed branch
is invisible. Preservation and resumption are complementary, not alternatives.

## Related

- [[feedback_passive_github_watcher_never_poll]] — same family: don't spend
  effort re-establishing state you already have a cheaper handle on.
