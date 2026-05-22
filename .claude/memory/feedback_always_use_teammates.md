---
name: feedback_always_use_teammates
description: "Use teammates for dev queues, subagents for one-shot architects/research — not \"always teammates\""
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 0ffbd21c-b73d-429a-a76d-4fb742ea9794
---

**Pick the spawn mode by lifecycle, not by default.**

- **Teammates** (`Agent` with `team_name: "js2wasm"`) — long-running. Use for **devs** pulling from TaskList, agents that need mid-task SendMessage redirects, or file-conflict coordination. Teammates do NOT self-terminate; tech lead sends `shutdown_request` → agent approves → lead removes pane.
- **Subagents** (`Agent` without `team_name`) — fire-and-forget. Use for **one-shot architects, research agents, spec writers, PO issue-file creators**. They read inputs, write an output file, return a summary, auto-cleanup. No pane management.

**Why this matters:** Confirmed against Claude Code docs (2026-05-21): the "always teammates" rule we previously enforced caused pane exhaustion. One-shot architects spawned as teammates idle forever waiting for orchestration that never comes. Subagents are designed precisely for fire-and-forget work and clean up automatically.

**When you actually need teammates:**
- Multiple devs grinding through a TaskList in parallel
- An agent that needs to receive SendMessage redirects mid-task
- An agent coordinating with another agent on file locks

**When you should use a subagent instead:**
- "Write one spec, exit"
- "Read the baseline JSONL, produce a report, exit"
- "Create three issue files, exit"
- Any task that has a single deliverable file

**How to apply:** Before spawning, ask "does this agent need to listen for new tasks or messages after completing this one?" If yes → teammate. If no → subagent.

See [[feedback_agent_self_termination]] for the matching shutdown protocol.
