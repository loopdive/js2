---
name: feedback-no-keep-pane
description: "Never instruct agents to \"do NOT kill your pane\" — always terminate after opening PR"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 0ffbd21c-b73d-429a-a76d-4fb742ea9794
---

After opening a PR, an agent must immediately do one of two things: claim the next unowned task from TaskList, or kill its pane. Idle-with-no-work is never acceptable.

**Why:** Telling an agent to keep its pane open without specifying a follow-on task leaves it in a third state — alive but doing nothing. This wastes a tmux slot and context.

**How to apply:** When redirecting an agent to a next task, name the task explicitly. If the queue is empty, tell them to terminate. Never say "stand by" or "keep your pane open" without a concrete next task attached. If you need to hold a pane open because you know a task is coming, say "claim task #N" — not "wait."
