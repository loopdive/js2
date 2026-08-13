---
tracker:
  kind: markdown
  issues_dir: plan/issues
  sprint: porffor-backend
  active_states: [ready, in-progress, in-review]
  claimable_states: [ready]
  claim_state: in-progress
  terminal_states: [done, wont-fix]
  include_dependencies: true
polling:
  interval_ms: 30000
pull_requests:
  enabled: true
  repository: loopdive/js2wasm
  command: gh
  poll_interval_ms: 30000
  timeout_ms: 30000
  review_states: [in-review, in-progress]
  sprint_only: true
  include_dependencies: true
workspace:
  kind: git_worktree
  root: .codex/worktrees/symphony-porffor
  base_ref: origin/main
  branch_prefix: symphony/porffor
  fetch_before_create: true
hooks:
  timeout_ms: 120000
  after_create: |
    git submodule update --init --checkout vendor/Porffor
    common_dir="$(git rev-parse --git-common-dir)"
    repo_root="$(cd "$common_dir/.." && pwd)"
    if [ -d "$repo_root/node_modules" ] && [ ! -e node_modules ]; then
      ln -s "$repo_root/node_modules" node_modules
    fi
agent:
  max_concurrent_agents: 1
  max_turns: 1
  max_retry_backoff_ms: 300000
  lanes:
    - name: porffor-codex-developer
      kind: codex
      role: teammate
      command: $SYMPHONY_CODEX_COMMAND
      prompt_mode: argument
      max_concurrent: 1
codex:
  command: codex exec -m gpt-5.6-sol -c approval_policy="never" --sandbox danger-full-access --skip-git-repo-check --json
  turn_timeout_ms: 3600000
  read_timeout_ms: 5000
  stall_timeout_ms: 300000
logging:
  root: .codex/symphony/porffor
---

You are implementing one dependency-ordered slice of JS2's optional Porffor
IR backend.

Issue: {{ issue.identifier }} - {{ issue.title }}
Issue file: {{ issue.file }}
Sprint: {{ issue.sprint }}
Workspace: {{ workspace.path }}
Branch: {{ workspace.branch }}
Pull request: {{ issue.pr }}
Attempt: {{ attempt }}
Agent lane: {{ agent.name }} ({{ agent.kind }} / {{ agent.role }})

Issue specification:

{{ issue.description }}

Rules:

- Work only inside the assigned workspace and only on this issue.
- Read `AGENTS.md`, `CLAUDE.md`, `.claude/memory/MEMORY.md`, and the assigned
  issue before substantial work.
- Treat `vendor/Porffor` as an optional pinned compatibility dependency. Core
  install, build, typecheck, and non-Porffor tests must work without it.
- Keep the JS2 linear-memory plan target-neutral. Porffor IR and its
  experimental C renderer are optional consumers, not the canonical or only
  destinations.
- Do not import Porffor internals statically from production `src/**` code and
  do not adopt Porffor's object layout, NaN boxing, builtins, or GC implicitly.
- Preserve the dependency boundaries and non-goals in the issue. Do not start
  a later P1-P5 slice from the same branch.
- Write focused tests in `tests/issue-{{ issue.identifier }}.test.ts` unless the
  issue specifies a more appropriate existing suite. Do not run full local
  test262.
- Complete exactly one issue-defined slice per PR and update the issue file
  with findings and acceptance status. If unchecked slices remain, leave the
  issue `in-progress` with its PR so Symphony requeues it after merge. Use
  `in-review` only for the final slice; Symphony marks that issue `done` after
  GitHub reports the PR merged.
- For a continuation slice, publish from the exact assigned branch. Symphony
  creates a fresh branch after every merged non-final slice; do not reuse an
  already-merged branch for the next Porffor slice.
- Commit all changes with a Claude Code-style message and a
  `Co-authored-by: Codex <codex@openai.com>` trailer.
- Merge current `origin/main` before implementation and merge it again before
  publishing if it advanced. Then push the assigned branch to `origin` and
  open a ready, non-draft PR against `main`.
- On a retry for an existing PR, inspect the failed checks, repair the same
  head branch, preserve `last_ci_retry_head`, and never open a duplicate PR.
- Enqueue the PR through the normal merge queue when GitHub accepts it. Never
  bypass required checks or force-merge.
- Report changed files, validation, commit SHA, PR URL, and queue state. A
  failed push, PR creation, or queue operation leaves the issue incomplete.
