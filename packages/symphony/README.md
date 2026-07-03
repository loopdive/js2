# Symphony

Symphony is a long-running scheduler/runner for markdown-driven coding-agent
dispatch. It reads eligible work from issue-file frontmatter, creates a
deterministic per-issue workspace (a git worktree), runs one coding-agent
command in that workspace, tracks runtime state, retries failures, and
exposes logs/status for the operator.

It does not care whether the agent behind a lane is Codex, Claude Code, or
anything else — a lane is just a shell command (or, for Claude Code, an MCP
channel event) that receives a rendered prompt and runs in an assigned
workspace.

Zero runtime dependencies — everything is Node.js built-ins.

## Install

```bash
npm install @loopdive/symphony
# or: pnpm add @loopdive/symphony
```

This adds three bins to your project: `symphony`, `symphony-channel`,
`symphony-dispatch`.

## Quick start

1. Copy [`WORKFLOW.example.md`](./WORKFLOW.example.md) to your project root
   as `WORKFLOW.md` and adjust the front matter (issue directory, workspace
   root, agent lanes) and the prompt template body to your project.
2. Make sure your issues live as markdown files with frontmatter matching
   `tracker.issues_dir` (default `plan/issues/<id>-<slug>.md`), each carrying
   at least `status:` and `sprint:` fields.
3. Try a dry run first — it exercises workflow loading, issue scanning, lane
   selection, and dispatch planning without creating worktrees or launching
   agents:

   ```bash
   npx symphony --once --dry-run
   ```

4. Run it for real:

   ```bash
   SYMPHONY_CODEX_COMMAND='codex exec --sandbox workspace-write --ask-for-approval never' \
   npx symphony --sprint 58 --max 4
   ```

## Repository contract

Symphony expects the consuming repo to provide:

- **A `WORKFLOW.md`** at the project root (or a path passed via
  `--workflow`): YAML front matter for `tracker` / `workspace` / `hooks` /
  `agent` / `codex` / `logging`, followed by a `{{ }}`-templated prompt body.
  See `WORKFLOW.example.md` for the full schema with comments.
- **Markdown issues** under `tracker.issues_dir` (default `plan/issues`),
  one file per issue, YAML frontmatter with at least `status:` (e.g. `ready`,
  `in-progress`, `done`) and `sprint:`.

The tracker adapter is markdown-backed because that's what fits a repo where
sprint membership and issue status are already canonical in frontmatter. A
different tracker backend (e.g. Linear) would only need to satisfy the same
`fetchCandidateIssues` / `claimIssue` / `fetchIssueStatesByIds` contract that
`MarkdownTracker` implements in `lib/workflow.mjs` — not implemented here yet.

## Issue status flow

- **claimable state(s)** (`tracker.claimable_states`, default `[ready]`):
  eligible for fresh dispatch.
- **active state(s)** (`tracker.active_states`, default `[ready, in-progress]`):
  used for retry/reconciliation — a run in this state is not cancelled just
  because its claim state changed underneath it.
- **terminal state(s)** (`tracker.terminal_states`, default
  `[done, wont-fix, closed, cancelled, canceled, duplicate]`): stops
  dispatch and reconciliation from touching the issue further.

On dispatch, Symphony immediately flips the issue frontmatter to
`tracker.claim_state` (default `in-progress`) in the main checkout, and
mirrors that status into the assigned worktree's copy of the issue file, so
the claimed issue isn't picked up again as fresh work.

## Agent lanes

Agents are configured as lanes under `agent.lanes` in `WORKFLOW.md`. Each
lane has:

- `name`
- `kind` — e.g. `codex`, `claude-channel`, or `generic`
- `role` — e.g. `team-lead` or `teammate`
- `command` (not needed for `claude-channel`)
- `prompt_mode` — `argument` or `stdin`
- `max_concurrent`

By default, a `codex` lane uses `codex.command` unless
`SYMPHONY_CODEX_COMMAND` overrides it. A `claude-channel` lane sends dispatch
events to an interactive Claude Code team lead instead of launching a
subprocess — see below.

## Claude Code channel

Claude Code channels are MCP servers that push events into an
already-running Claude Code session. Point a project's `.mcp.json` at the
bundled channel server:

```json
{
  "mcpServers": {
    "symphony": { "command": "symphony-channel" }
  }
}
```

Then start Claude Code with the channel enabled:

```bash
claude --dangerously-load-development-channels server:symphony
```

When Symphony dispatches to a `claude-channel` lane, it writes a dispatch
event to `<project>/.codex/dispatch/messages.jsonl`. The channel server
watches that file and emits `notifications/claude/channel` into the Claude
session. The Claude lead should use native Claude Code Team/TaskList tools
to do the actual work, and can call the channel's `reply` / `claim_issue` /
`complete_issue` / `release_issue` tools to talk back to Symphony. If no
Claude session is running with the channel enabled, the message just waits
in `.codex/dispatch/` until one starts.

## `symphony-dispatch` CLI

A companion CLI for operators/hooks to inspect or drive the same
`.codex/dispatch/` state without going through the daemon:

```bash
npx symphony-dispatch queue                       # claimable issues for the current sprint
npx symphony-dispatch request-claude               # ask the Claude lead to fill its TaskList
npx symphony-dispatch claim --issue 42 --owner codex-lead
npx symphony-dispatch complete --issue 42
npx symphony-dispatch release --issue 42 --reason "blocked on design"
npx symphony-dispatch message --to claude-lead --body "..."
npx symphony-dispatch inbox --to claude-lead --consume
npx symphony-dispatch status
```

## Safety posture

- The daemon refuses to launch an agent with its workspace `cwd` equal to
  the project root.
- Every agent subprocess runs with `cwd` set to its assigned workspace.
- Workspace paths are sanitized and must stay under the configured
  workspace root (`workspace.root`, default `.codex/worktrees/symphony`).
- Worktrees are preserved after runs. Terminal-state reconciliation cancels
  active runs but does not remove worktrees without operator inspection.
- The configured agent command controls that agent's own
  approval/sandbox behavior — Symphony does not sandbox on its behalf.
- Claude Code team work stays inside the interactive Claude session.
  Symphony only sends channel events to the Claude lead; it does not edit
  Claude-generated team/task files and does not launch `claude -p` unless a
  separate executable Claude lane is explicitly configured.

## Commands

```bash
symphony --dry-run --once
symphony --sprint 58 --max 3
symphony --once --sprint 58 --max 3
symphony --status
symphony --control pause
```

## Package layout

```
bin/
  symphony.mjs           daemon CLI entry
  symphony-channel.mjs   MCP channel server for Claude Code
  symphony-dispatch.mjs  claims/messages/queue CLI
lib/
  yaml.mjs               minimal YAML-subset + frontmatter parser
  workflow.mjs           WORKFLOW.md loader, MarkdownTracker, template render
  dispatch-state.mjs     shared claims.json / messages.jsonl I/O
  orchestrator.mjs       WorkspaceManager, Logger, AgentRunner, Orchestrator
  util.mjs               small path/env/shell helpers
```

`lib/` is also exported (see `package.json#exports`) if you want to build a
different CLI or tracker adapter on top of the same primitives.

## Current scope

Implemented:

- workflow loader with YAML frontmatter and strict prompt variables
- markdown issue tracker adapter
- bounded concurrency and lane selection
- deterministic git-worktree workspace creation/reuse
- before/after workspace hooks
- generic command runner
- Claude Code channel lane for interactive Claude team-lead dispatch
- structured JSONL logs
- runtime state snapshot
- retry/backoff and stall reconciliation

Not implemented yet:

- Non-markdown tracker adapters (e.g. Linear)
- Codex app-server JSON-RPC client
- optional HTTP status API
- durable DB beyond restart-readable repo/tracker/workspace state
