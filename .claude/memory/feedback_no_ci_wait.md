---
name: feedback-no-ci-wait
description: Dev agents must not idle in ci-wait — open PR then move on
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 0ffbd21c-b73d-429a-a76d-4fb742ea9794
---

Dev agents should NOT wait for CI after opening a PR. Their job ends when the PR is open.

**Why:** Agents idling in ci-wait burn team slots without doing useful work. CI monitoring and merging is the tech lead's job via the auto-merge monitor.

**How to apply:** After `gh pr create`, agents immediately clean up their worktree, mark their task completed, then claim the next task from TaskList or `tmux kill-pane -t $TMUX_PANE` if none are available. No ci-wait loop, no polling, no background monitoring.
