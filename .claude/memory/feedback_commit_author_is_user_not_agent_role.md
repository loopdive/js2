---
name: feedback_commit_author_is_user_not_agent_role
description: "Agent commits must be authored by the USER (Thomas Tränkler <git@thomas.traenkler.com>) with the actual producing agent named as co-author."
metadata:
  node_type: memory
  type: feedback
  originSessionId: f3739381-bbf1-4f5c-9036-57a3a6c8eeac
---

**User directive (clarified 2026-07-26):** commits produced by an AI agent must
ALWAYS be authored by the USER — "ttraenkler" =
**Thomas Tränkler <git@thomas.traenkler.com>** — and co-authored by the agent
that actually produced the work:

```text
# Codex session
Co-authored-by: Codex <codex@openai.com>

# Claude session
Co-authored-by: Claude <noreply@anthropic.com>
```

Never attribute Codex work to Claude or Claude work to Codex. Never use an
agent-role identity such as `senior-dev` as the Git author.

**Why:** the container's GLOBAL `~/.gitconfig` had `user.name=senior-dev`,
`user.email=claude.ai@loopdive.com` (set 2026-07-14). All agent commits inherit the global
config (worktrees don't override it), so 379 commits landed on main mis-authored
"senior-dev" before the user noticed.

**How to apply:**
- Fixed 2026-07-20: `git config --global user.name "Thomas Tränkler"` +
  `git config --global user.email "git@thomas.traenkler.com"`. All worktrees/agents inherit it.
- **Verify `git config --get user.name` is NOT a role name before committing from any fresh
  env / after any resume.** If it reverted, re-fix.
- **Already-published commits (public main = append-only) CANNOT be re-authored.** But UNMERGED
  PR-branch commits CAN — re-author with `git commit --amend --reset-author --no-edit` (single)
  or `git rebase origin/main --exec "git commit --amend --no-edit --reset-author"` (multi,
  non-interactive), preserve the actual producing agent's co-author trailer, force-push to `fork` (unmerged
  branch = safe, NOT main). Did this for observability PRs #3442/#3445.
- User uses 4 emails (all "Thomas Tränkler"); primary = git@thomas.traenkler.com. Offer to
  switch to github.com@loopdive.com (loopdive work email) if they prefer work-context attribution.

See [[feedback_pr_title_coauthor_conventions]], [[feedback_public_main_append_only]].
