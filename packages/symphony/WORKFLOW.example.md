---
tracker:
  kind: markdown
  # Directory of markdown issue files, each with YAML frontmatter. File name
  # doesn't matter beyond matching the id pattern; frontmatter is authoritative.
  issues_dir: plan/issues
  # "latest" picks the highest-numbered non-terminal sprint; or pin a number.
  sprint: latest
  # active_states: eligible for retry/reconciliation without being treated
  # as freshly claimable (an in-progress issue isn't re-dispatched).
  active_states: [ready, in-progress]
  # claimable_states: eligible for fresh dispatch.
  claimable_states: [ready]
  # State written to the issue file the moment it's claimed.
  claim_state: in-progress
  # Terminal states stop dispatch/reconciliation from touching the issue.
  terminal_states: [done, wont-fix]
workspace:
  kind: git_worktree
  # Where per-issue worktrees are created, relative to the project root.
  root: .codex/worktrees/symphony
  # Branch each new worktree from this ref.
  base_ref: origin/main
  # New branches are named "<branch_prefix>/<sanitized-issue-id>".
  branch_prefix: symphony
hooks:
  timeout_ms: 60000
  # Runs once, right after a new worktree is created, cwd = the worktree.
  # Handy for symlinking node_modules or other setup that's expensive to
  # duplicate per worktree.
  after_create: |
    if [ -d /path/to/shared/node_modules ] && [ ! -e node_modules ]; then
      ln -s /path/to/shared/node_modules node_modules
    fi
agent:
  max_concurrent_agents: 8
  # How many times to re-invoke the same lane command for one issue before
  # giving up (1 = no automatic continuation turns).
  max_turns: 1
  max_retry_backoff_ms: 300000
  lanes:
    # A "codex" (or any shell-command) lane: symphony spawns `command` with
    # cwd set to the issue's worktree and the rendered prompt appended
    # (prompt_mode: argument) or piped to stdin (prompt_mode: stdin).
    - name: codex-developer
      kind: codex
      role: teammate
      command: $SYMPHONY_CODEX_COMMAND
      prompt_mode: argument
      max_concurrent: 8
    # A "claude-channel" lane: instead of spawning a subprocess, Symphony
    # writes a dispatch event that an interactive Claude Code session (with
    # the bundled MCP channel server running) picks up. See README.md.
    # - name: claude-lead
    #   kind: claude-channel
    #   role: team-lead
    #   recipient: claude-lead
    #   max_concurrent: 1
codex:
  # Fallback command for any lane with kind: codex that doesn't set its own
  # `command` — overridden per-run by $SYMPHONY_CODEX_COMMAND.
  command: codex exec -c approval_policy="never" --sandbox danger-full-access --skip-git-repo-check --json
  turn_timeout_ms: 3600000
  read_timeout_ms: 5000
  # If no output/event arrives for this long, the run is considered stalled
  # and killed/released.
  stall_timeout_ms: 300000
logging:
  root: .codex/symphony
---

You are working through Symphony.

Issue: {{ issue.identifier }} - {{ issue.title }}
Issue file: {{ issue.file }}
Sprint: {{ issue.sprint }}
Workspace: {{ workspace.path }}
Branch: {{ workspace.branch }}
Attempt: {{ attempt }}
Agent lane: {{ agent.name }} ({{ agent.kind }} / {{ agent.role }})

Rules:

- Work only inside the assigned workspace; do not edit the main checkout.
- Handle exactly this issue; do not claim or self-serve another task.
- Run scoped validation for this change; do not run your full test suite.
- Update the issue file on the implementation branch with final findings and
  status before finishing.
- Commit your changes on the assigned branch.
- Merge or rebase the base ref into the assigned branch before publishing so
  any pull request is based on current upstream.
- Report changed files, validation run, commit SHA, and any blockers before
  exiting.
