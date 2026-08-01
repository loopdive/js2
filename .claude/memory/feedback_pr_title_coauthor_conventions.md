---
name: feedback_pr_title_coauthor_conventions
description: "Follow project PR title conventions and add a co-author trailer naming the agent that produced the work"
---

# PR, branch, and co-author conventions

When creating or updating PRs in this project, follow the established project PR
title style: a specific conventional-commit-style title such as
`fix(scope): concise summary` that names the real change. Do not prefix PR
titles with `[codex]`.

For Codex-authored issue work, branch names must follow the project convention:
`codex/<issue-id>-<slug>`, for example `codex/1784-typedarray-packed-lane-storage`.
Do not use vague Codex branch names that omit the local plan issue number.

For agent-authored commits/PR updates, the co-author trailer must identify the
agent that actually produced the work:

```text
# Codex session
Co-authored-by: Codex <codex@openai.com>

# Claude session
Co-authored-by: Claude <noreply@anthropic.com>
```

Never attribute Codex work to Claude or Claude work to Codex.
