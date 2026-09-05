# Agent Instructions

## Claude Memories

- Before substantial work, review the markdown memories under [.claude/memory](.claude/memory).
- Start with [MEMORY.md](.claude/memory/MEMORY.md), then read any task-relevant files in the same directory.
- Treat those memory files as repo-specific operating context, especially around test262 workflow, agent coordination, cleanup rules, and user preferences.

## Commit Messages

- Use Claude Code-style commit messages.
- Write a specific subject line that states the main change clearly.
- Add a body when the change is non-trivial.
- In the body, explain what changed and why it changed.
- Call out behavior changes, important tradeoffs, or follow-up work when relevant.

Preferred shape:

```text
<type>(<scope>): <concise summary>

Explain the main implementation change and the reason for it.

Note behavior changes, risks, or follow-ups if they matter.
```

Examples of acceptable types: `fix`, `feat`, `refactor`, `docs`, `test`, `chore`.

## Commit Attribution

- Commits produced by an AI agent must be authored by the user:
  `Thomas Tränkler <git@thomas.traenkler.com>`.
- Add a co-author trailer identifying the agent that actually produced the
  commit:

```text
# Codex session
Co-authored-by: Codex <codex@openai.com>

# Claude session
Co-authored-by: Claude <noreply@anthropic.com>
```

- Never attribute Codex work to Claude or Claude work to Codex.
- **Also add a `Model:` trailer naming the exact model that produced the
  commit — vendor, family, version/subtype, and the configured reasoning
  effort** (project-lead order, 2026-08-29; enforced by `.husky/commit-msg`
  for any commit carrying an agent co-author trailer):

```text
Model: Claude Fable 5 Max
Model: Codex GPT-5.6 Sol Max
Model: Claude Opus 5 High
```

  - Effort is the level your session/task was configured with — the dispatch
    brief or the issue's `reasoning_effort` frontmatter; if genuinely
    unknown, write `Default`. Do not guess a higher tier than you know.
  - Auto-generated subjects (`Merge …`, `Revert …`, `fixup!`, `squash!`,
    `chore(assign)…`) are exempt.
  - Why: PR #5204 shipped three codegen regressions in one agent commit and
    the model that produced it was unrecoverable from git. This trailer makes
    that question answerable per commit.
  - This project rule deliberately **overrides** any ambient harness default
    of keeping model identifiers out of pushed artifacts (same precedence as
    the "always open a PR" rule in CLAUDE.md).
- Before committing, verify `git config user.name` and `git config user.email`
  still identify Thomas Tränkler.
