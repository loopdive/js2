---
name: feedback-5h-window-pause-resume
description: "At ≥99% of the 5-hour token window, pause the fleet and schedule a wakeup for the next window start"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 1ef96580-7db6-4559-9e05-7f637b7f44c5
  modified: 2026-07-26T01:11:13.604Z
---

When driving a sprint loop: if the **5-hour rolling token window** reaches ~99% spent, STOP dispatching/resuming agents, and schedule a wakeup for when the next 5-hour window opens (user directive 2026-07-02).

**Why:** burning the last 1% on partial agent turns wastes it — agents die mid-turn on rate limits and need costly resumes anyway. Pausing cleanly and resuming on window reset preserves both budget and agent state (state lives in git; watchers/PRs continue server-side while paused).

**How to apply:** detection = agents dying with rate-limit (429 / "limit reached") errors, or the statusline cache (`~/.claude/js2wasm-budget.json`) if it carries 5h-window fields. On trigger: (1) **actively PAUSE the whole team** — send `PAUSE` via SendMessage to every live teammate, don't merely stop resuming dead ones; (2) don't resume dying agents; (3) note fleet state in one message; (4) background `sleep <secs-to-reset>` (Bash run_in_background — re-invokes on exit) or chained ScheduleWakeup (3600s max per hop) until the reset; (5) **on wake, RESUME the team** (`RESUME` via SendMessage), re-check budget, and rotate the fleet back in (state-in-git handoffs). Related: [[feedback_token_budget_guardrails]], [[feedback_usage_limit]].

**Reaffirmed by the user 2026-07-26**, in these words: *"always pause the team when the 5h window budget is 99% used and set a wake up for the team right after the window resets."* Both halves are required — pausing without a scheduled wakeup strands the fleet for the rest of the window.
