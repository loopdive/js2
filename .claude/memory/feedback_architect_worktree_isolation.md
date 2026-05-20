---
name: feedback-architect-worktree-isolation
description: Always spawn architect agents with isolation:worktree — they request it every time
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 0ffbd21c-b73d-429a-a76d-4fb742ea9794
---

**DO NOT** pass `isolation: "worktree"` when spawning architect agents — it creates worktrees outside `/workspace/.claude/worktrees/` which the `check-worktree-path.sh` hook rejects, leaving the agent stranded in /workspace anyway.

**Correct pattern (session 0ffbd21c):**
1. Tech lead manually creates the worktree FIRST from /workspace:
   `git worktree add /workspace/.claude/worktrees/arch-<name> -b arch-<name> origin/main`
2. Spawn architect WITHOUT isolation (bare `Agent(subagent_type: "architect")`)
3. In the prompt, tell the architect their worktree path explicitly:
   "Work from /workspace/.claude/worktrees/arch-<name>. Prefix all git commands with `git -C /workspace/.claude/worktrees/arch-<name>`."

**Why:** The `isolation: "worktree"` feature creates worktrees in a non-canonical path (e.g. /tmp) which is rejected by check-worktree-path.sh. The agent then ends up in /workspace where check-cwd.sh blocks all git ops for non-tech-lead roles. Result: agent is stranded and requests respawn — the exact failure mode we're trying to avoid.

**How to apply:** Pre-create worktrees, spawn architects without isolation, hand them the path in the prompt.
