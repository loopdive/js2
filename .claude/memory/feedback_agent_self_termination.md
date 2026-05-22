---
name: feedback-agent-self-termination
description: "Teammate agents idle after finishing — correct pattern is subagents for one-shot work, shutdown_request for teammates"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 0ffbd21c-b73d-429a-a76d-4fb742ea9794
---

Architects and research agents regularly finish their work and sit idle. `tmux kill-pane` is NOT the correct termination mechanism — it's an unsupported workaround.

**Root cause (confirmed via Claude Code docs 2026-05-21):**
- **Teammates** (Agent with team_name) never self-terminate. The lead orchestrates shutdown via `shutdown_request` → `shutdown_response`. Without a shutdown_request from the lead, they idle forever.
- **Subagents** (Agent without team_name) auto-cleanup when done — correct for fire-and-forget work.

**Correct patterns:**
- One-shot architects/research agents → spawn as **subagents** (omit `team_name`). They run, return results, auto-cleanup.
- Dev agents needing ongoing coordination (TaskList, SendMessage, mid-task redirects) → **teammates** with team_name.
- When a teammate signals done → tech lead sends `{"type": "shutdown_request"}` via SendMessage → teammate approves → pane closes.

**What NOT to do:**
- Do NOT tell agents to `tmux kill-pane` — unreliable, bypasses lifecycle.
- Do NOT use team_name for one-shot spec/research agents.
- Do NOT suppress all messages from agents — you need their "done" signal to send shutdown_request.

**How to apply:**
- Check each new agent dispatch: does it need ongoing SendMessage/TaskList coordination? → teammate. One-shot output? → subagent (no team_name).
- When an architect sends "Done." message → immediately send shutdown_request.
- If an agent is stuck idle with completed work → user can terminate manually; it's a lifecycle management issue not a crash.
- See [[feedback_dev_silence_protocol]] for the dev communication rules (different from arch rules).
