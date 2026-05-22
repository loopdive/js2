---
name: PR Drift Protocol
description: How drifted PRs in the merge queue get re-merged with main via the @claude comment + shell-poll handoff
type: project
---

# PR Drift Protocol

When a PR is waiting in the merge queue and main moves, GitHub's strict
required-status-checks policy bounces the PR (its CI no longer reflects current
main). To get the PR back on track without burning agent tokens watching, we
use a three-stage handoff:

```
push to main
  ↓
pr-drift-detect.yml workflow (free GH Actions)
  finds queued PRs with non-trivial drift
  ↓
  posts PR comment tagging @claude:
    "merge main into branch, review diff, push"
  ↓
scripts/poll-pr-mentions.sh (shell, no LLM)
  running in a tmux pane / launchd service
  polls GitHub for new comments containing @claude
  emits one line per new mention
  ↓
tech lead notices the line in their terminal
  spawns a developer agent with the comment URL
  ↓
developer agent (Claude)
  merges main, reviews diff, pushes
  ↓
fresh PR-level CI runs → PR re-eligible → queue picks it up
```

## Components

### 1. `pr-drift-detect.yml`

Fires on every push to main. For each PR with auto-merge enabled, computes
how many non-`[skip ci]` commits its base is behind. If above the
configurable threshold, posts a PR comment containing `@claude` and a
dedup marker `<!-- pr-drift-detector main=<sha> -->`.

The marker prevents re-posting for the same main HEAD if the workflow
runs multiple times (e.g. retry after transient error).

### 2. `scripts/poll-pr-mentions.sh`

Pure shell. Polls `repos/{owner}/{repo}/issues/comments?since={ts}` every
60 seconds (configurable). For each new comment containing `@claude`,
emits a single line:

```
[2026-05-22T10:15:23Z] @github-actions[bot] on #419: 🔄 Main has moved while this PR is waiting...
```

State (last-seen timestamp) persists in `~/.cache/poll-pr-mentions-state`
so restarts don't replay old events.

**No tokens used.** Just `gh api` (free) and `jq`. Designed to run in a
tmux pane, a `launchd` agent on macOS, or `systemd --user` on Linux.

### 3. Tech lead dispatch (manual, until automated)

When tech lead sees a line in the polling output:

1. Read the comment: `gh pr view <num> --comments`
2. Spawn a developer agent in worktree mode:
   ```
   Agent("Merge main into PR #N", "Read .../pr-drift-protocol.md, merge origin/main into the PR branch in its worktree, review the combined diff for semantic conflicts (API drift, signature changes), push if safe, comment on the PR with the agent's findings.")
   ```
3. Agent does the work, pushes, exits. PR's CI re-fires, PR re-enters queue.

## Why not automate the dispatch?

We could pipe the polling output to a hook that auto-spawns an agent on
every mention. But during the bootstrap phase we want to:

1. Validate that the drift-detection signal is accurate (right PRs flagged?)
2. Validate the agent prompt produces useful diffs
3. Catch false positives (e.g. `@claude` mentioned for unrelated reasons)

After ~10 successful manual dispatches, the polling script can be extended
with a `--auto-dispatch` flag that spawns the developer agent directly.

## Cost accounting

- Drift detection: 1 GH Actions minute per push to main (free quota)
- Polling: zero tokens (shell + gh API)
- Dispatch: ~1 agent-turn per drift event (~50k tokens of context, ~$0.25 with Sonnet)
- Avg drift events per PR: ~1 in healthy queue, ~3-5 during heavy merge waves

Estimated cost per 100 PRs merged: ~$25 in agent tokens for drift handling.
Trade-off for serial-queue + per-PR validation correctness.

## Tuning

- `DRIFT_THRESHOLD` in `pr-drift-detect.yml`: minimum commits behind before
  commenting. Start at 1, increase if too noisy.
- `INTERVAL_SECS` in the polling script: how often to check. 60s is fine
  for human-driven dispatch; lower to 15s if you want faster reaction.

## Lifecycle — keeping the watcher alive

The polling script runs as a session-scoped Monitor (started by the tech
lead at session boot, see `session-start-checklist.md`). When the session
ends or crashes, the Monitor dies and the poller stops. Events posted to
GitHub during the gap are *not lost* — the state file
(`/tmp/poll-pr-mentions-state`) records the last-seen timestamp and the
next start replays everything since.

**Tech lead responsibility per session:**

1. **At session start** — start the Monitor (item 14 in
   `session-start-checklist.md`). The state file ensures gap recovery.
2. **Mid-session** — if you notice the Monitor is gone from `TaskList`
   (crash, accidental TaskStop), restart it immediately with the same
   command. The state file will replay missed events.
3. **At session end** — no special action; the Monitor dies naturally,
   gap recovery happens at the next start.

**If you want true always-on** (script runs 24/7 independent of any Claude
session): wrap `scripts/poll-pr-mentions.sh` in a launchd plist (macOS) or
`systemd --user` unit (Linux) with `KeepAlive=true`. Then it survives
session ends entirely. The Monitor in-session becomes redundant for
notification but still useful as a real-time event stream for the
dispatching session.

## See also

- `.github/workflows/pr-drift-detect.yml`
- `scripts/poll-pr-mentions.sh`
- Merge queue config in repo ruleset (`max_entries_to_merge: 1`,
  `strict_required_status_checks_policy: true`)
