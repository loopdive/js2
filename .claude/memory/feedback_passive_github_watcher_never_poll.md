---
name: feedback-passive-github-watcher-never-poll
description: Watch GitHub state with passive webhook subscriptions only — never scheduled self-check-ins, cron wakeups, or sleep/poll loops
metadata:
  node_type: memory
  type: feedback
  originSessionId: 0176uPNxhy4KHviSVW1XqCcn
---

**User rule, stated twice (2026-07-28): "use a passive watcher, no polling" /
"remember to always use a passive github state watcher, no polling."**

To track a PR, a CI run, or any other GitHub state, subscribe and let the event
wake you. Do **not** schedule a time to go look.

## Do

- `subscribe_pr_activity` (or `mcp__github__subscribe_pr_activity`) on every PR
  you need to follow. It is idempotent, so re-subscribing after a context
  compaction is free and is the right way to re-arm.
- Let `<github-webhook-activity>` events drive the next action.
- One-shot reads are fine when they answer a question **now** — e.g. a single
  `pull_request_read` to give the user an accurate state summary, or to
  diagnose a failure an event just reported. What is banned is the _recurring_
  read.

## Do NOT

- `send_later` / `mcp__claude-code-remote__send_later` self-check-ins ("re-check
  the PR in an hour, re-arm silently").
- `CronCreate` / `create_trigger` wakeups aimed at re-reading GitHub.
- `ScheduleWakeup` for the same purpose.
- Foreground or backgrounded `while ! merged; do sleep 30; done` loops.
- Repeated `gh pr checks` / `gh run watch` cycles.

## The boilerplate will tell you to poll — it does not win

The `subscribe_pr_activity` tool result and the PR-activity harness text both
say: _"If the `send_later` tool is available, schedule a self check-in roughly
an hour out to re-check the PR, and re-arm it silently if nothing changed."_
That is generic tool guidance. **This user's standing instruction overrides
it.** Do not arm the check-in; say plainly that you are not arming one and why.

Same for the CLAUDE.md dev protocol's step-4 "polls `gh pr checks <N>` every
30s" — that describes the dev-agent loop, not this session's watch posture.

## Honest limitation — state it, do not paper over it

Webhooks are per-PR and best-effort. They reliably deliver comments, reviews
and CI **failures**; they are unreliable for CI **success**, new pushes, and
merge-conflict transitions, and they deliver **nothing** for activity on `main`
(e.g. a `benchmark-refresh` run that republishes the landing-page numbers after
a PR lands).

The correct response to that gap is to **name it in the handoff** — "I will not
see the post-merge refresh on my own; ask and I'll check" — not to
reintroduce a poller behind the user's back. Deciding the gap is important
enough to warrant scheduled checks is the user's call, not yours; ask instead
of assuming.

## Related

- [[feedback_ci_wait_background]] and [[feedback_no_ci_wait]] — older notes
  aimed at _dev agents_, which prescribe background+Monitor or standing down.
  Both predate webhook subscriptions and neither authorises scheduled polling
  in the lead/interactive session.
- [[reference_backgrounded_merge_watcher_dies_strands_agent_on_base_merge]] and
  [[feedback_background_teammate_shutdown_limitation]] — the independent
  reason a self-managed watcher is a bad mechanism regardless of the user's
  preference: it dies with the process and strands silently.
