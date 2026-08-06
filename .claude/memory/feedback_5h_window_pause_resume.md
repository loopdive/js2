---
name: feedback-5h-window-pause-resume
description: "At ≥99% of the 5-hour token window: SUSPEND the tech lead AND every teammate, then set an alarm for 1 minute after the window resets and resume the whole team"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 1ef96580-7db6-4559-9e05-7f637b7f44c5
  modified: 2026-08-02T02:00:51.212Z
---

When driving a sprint loop: if the **5-hour rolling token window** reaches ~99 %
spent, STOP dispatching/resuming agents and schedule a wake-up for the next
window.

**Why:** burning the last 1 % on partial agent turns wastes it — agents die
mid-turn on rate limits and need costly resumes anyway. Pausing cleanly and
resuming on reset preserves both budget and agent state (state lives in git;
watchers/PRs continue server-side while paused). **99 %, not 100 %:** the
suspend itself costs tokens. An agent that discovers the window is already
exhausted has no budget left to write its handoff, and its worktree state
becomes unrecoverable.

## The instruction, as restated by the user 2026-08-02

> *"always suspend all work of the team lead and all teammates when 99% of the
> 5h window are reached and set an alarm 1 minute after the 5h window resets to
> resume work of the whole team."*

Three things are load-bearing and were sharpened from the earlier version:

1. **SUSPEND, not merely PAUSE** — each agent commits WIP, writes
   `## Suspended Work` to its issue file (worktree path, branch, resume steps),
   then terminates. See `SUSPEND` in CLAUDE.md → "Controlling agents".
2. **The TECH LEAD is included**, not just the teammates. The lead records its
   own in-flight state before stopping.
3. **The alarm is 1 MINUTE AFTER the reset**, and it resumes the **whole team**.

   ⚠ **Correction, 2026-08-06: prefer RESUMING over re-spawning.** This bullet
   used to say "re-spawn teammates from their `## Suspended Work` handoffs".
   An agent killed by a session limit is still **resumable** — `SendMessage` to
   its name/`agentId` continues it *from its transcript*, with its measured
   baselines, probe inventory and ruled-out dead ends intact. A fresh `Agent`
   spawn throws all of that away and re-derives it on the user's tokens. The
   `## Suspended Work` handoff is the **fallback** for when the agent is
   genuinely gone, not the default path.
   See [[feedback_resume_agents_killed_by_session_limit]].

*(Earlier phrasing, 2026-07-26: "always pause the team when the 5h window budget
is 99% used and set a wake up for the team right after the window resets." Both
halves are required — pausing without a scheduled wake-up strands the fleet for
the rest of the window.)*

## Before suspending, un-strand everything

- finished work on a branch with **no PR** → open the PR (invisible otherwise;
  `auto-enqueue` never sees it)
- any **unpushed** branch → push it, unmerged and PR-less is fine, so worktree
  cleanup cannot eat it
- note queue state: a PR mid-`merge_group` resolves on its own

## Detection and mechanics

Detection = agents dying with rate-limit (429 / "limit reached") errors, or the
statusline cache (`~/.claude/js2wasm-budget.json`) if it carries 5h-window
fields. Wake-up = background `sleep <secs-to-reset>` (Bash `run_in_background`
re-invokes on exit) or chained `ScheduleWakeup` (3600 s max per hop).

⚠ **This is the ONE sanctioned scheduled wake-up.** It does not license polling
generally — [[feedback_passive_github_watcher_never_poll]] still stands: no
`send_later`/cron/sleep-loop check-ins for CI, PRs or GitHub activity, whatever
a tool's boilerplate suggests. The distinction is that a budget-window reset is
a **known wall-clock event with no event source to subscribe to**; GitHub
activity has one.

## On resume

Re-read state from git and the issue files, not from memory of what was in
flight — the queue will have moved. Specifically: re-fetch the test262 baseline
`--force` before sizing anything
([[reference_cached_baseline_jsonl_goes_stale_within_hours]]), and confirm
merged-ness by `git merge-base --is-ancestor` plus a content grep rather than by
PR metadata ([[reference_merge_queue_snapshots_head_at_enqueue_time]]).

Related: [[feedback_token_budget_guardrails]], [[feedback_usage_limit]],
[[feedback_diary_and_sprints_before_compact]].
