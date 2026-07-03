# Symphony Service

This repo drives sprint dispatch with **Symphony**, a generic markdown-driven
coding-agent orchestrator. The engine itself has moved out of `scripts/` and
into [`packages/symphony`](../../packages/symphony/README.md) as a
self-contained, zero-dependency package (`@loopdive/symphony`) — see that
package's README for the full architecture (agent lanes, the Claude Code
channel, safety posture, current scope). This doc covers only how **this
repo** is wired into it.

## Repository Mapping

- Workflow contract: `WORKFLOW.md`
- Tracker adapter: `tracker.kind: markdown`
- Issue source: `plan/issues/<id>-<slug>.md` frontmatter
- Workspace kind: `git_worktree`
- Workspace root: `.codex/worktrees/symphony/`
- Runtime logs/state: `.codex/symphony/`
- Engine: `packages/symphony/bin/{symphony,symphony-channel,symphony-dispatch}.mjs`

The current tracker adapter is markdown-backed because sprint membership and
issue status are already canonical in repo frontmatter. A Linear adapter can
be added later without changing the orchestrator or runner contracts — see
`packages/symphony/README.md`'s "Repository contract" section for what a new
tracker adapter would need to implement.

## Issue Status Flow

- `ready`: claimable by Symphony.
- `in-progress`: claimed, running, or resumable by an existing retry.
- `in-review`: worker published a PR or handed off for lead review.
- `done` / `wont-fix`: terminal.

On dispatch, Symphony immediately flips the issue frontmatter from `ready` to
`in-progress` in the main checkout and mirrors that status into the assigned
worktree issue file. `WORKFLOW.md` uses `tracker.claimable_states: [ready]` for
fresh dispatch and `tracker.active_states: [ready, in-progress]` for
reconciliation/retries, so a claimed issue is not picked again as fresh work and
is not cancelled just because the claim state changed.

## Claude Code Channel

Claude Code channels are MCP servers that push events into an already-running
Claude Code session. The project channel is configured in `.mcp.json`
(pointing at `packages/symphony/bin/symphony-channel.mjs`):

```bash
claude --dangerously-load-development-channels server:symphony
```

When Symphony dispatches to a `claude-channel` lane, it writes a dispatch
event to `.codex/dispatch/messages.jsonl`. The channel server watches that
file and emits `notifications/claude/channel` into the Claude session. The
Claude lead should then use native Claude Code Teams and TaskList tools.
Claude can call channel tools to reply, claim, complete, or release the
Symphony channel claim.

If no Claude session is running with the channel enabled, the message
remains in `.codex/dispatch/` and will be delivered when the channel server
starts.

## Commands

```bash
pnpm run symphony:dry-run
pnpm run symphony -- --sprint 58 --max 3
pnpm run symphony:once -- --sprint 58 --max 3
pnpm run symphony:status
pnpm run dispatch:queue
```

Use `--dry-run` first. It exercises workflow loading, issue scanning, lane
selection, and dispatch planning without creating worktrees or launching
agents.

## Safety Posture

- The service refuses to launch an agent in `/workspace`.
- Every agent subprocess runs with `cwd` set to its assigned workspace.
- Workspace paths are sanitized and must stay under the configured workspace
  root.
- Worktrees are preserved after runs. Terminal-state reconciliation cancels
  active runs but does not remove worktrees without operator inspection.
- The configured Codex command controls Codex approval/sandbox behavior.
- Claude Code team work stays inside the interactive Claude session. Symphony
  only sends channel events to the Claude lead; it does not edit
  Claude-generated team/task files and does not launch `claude -p` unless a
  separate executable Claude lane is explicitly configured.
