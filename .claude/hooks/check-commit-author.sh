#!/bin/bash
# PreToolUse hook: block `git commit` when the resolved author identity is
# Claude/Anthropic-ish. Commits by an AI agent must be authored by the human
# user, with the producing agent named only as a Co-authored-by trailer — see
# .claude/memory/feedback_commit_author_is_user_not_agent_role.md.
#
# This mirrors .husky/commit-msg (which enforces the same rule at the git
# level, after formatting/lint-staged/ratchets have already run) so a
# Claude-ish author is caught immediately, before the slow pre-commit chain.

INPUT=$(cat)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)
if [ -z "$CMD" ]; then
  exit 0
fi

# Only act on an actual `git commit` invocation, at a command boundary, so we
# don't false-positive on the phrase appearing inside a heredoc commit-message
# body or a `gh` argument. Match on the first line only for the same reason
# check-cwd.sh does.
FIRST_LINE=$(echo "$CMD" | head -1)
if ! echo "$FIRST_LINE" | grep -qE '(^|[;&|])[[:space:]]*git([[:space:]]+-C[[:space:]]+\S+)?[[:space:]]+commit([[:space:]]|$)'; then
  exit 0
fi

# Resolve the -C <path> target (if any) so we read identity/config from the
# repo the commit actually targets, not the hook's cwd.
GIT_DIR_ARG=()
C_PATH=$(echo "$FIRST_LINE" | grep -oE -- '-C[[:space:]]+\S+' | head -1 | sed -E 's/^-C[[:space:]]+//')
if [ -n "$C_PATH" ]; then
  GIT_DIR_ARG=(-C "$C_PATH")
fi

CLAUDE_PATTERN='claude|anthropic'

case_insensitive_match() {
  printf '%s' "$1" | grep -qiE "$2"
}

# Inline env overrides on the command line (e.g. `GIT_AUTHOR_NAME=... git
# commit ...`) take precedence over both repo config and the hook's own
# environment — mirror git's own precedence.
INLINE_NAME=$(echo "$FIRST_LINE" | grep -oE 'GIT_AUTHOR_NAME=[^[:space:]]*' | tail -1 | sed -E 's/^GIT_AUTHOR_NAME=//')
INLINE_EMAIL=$(echo "$FIRST_LINE" | grep -oE 'GIT_AUTHOR_EMAIL=[^[:space:]]*' | tail -1 | sed -E 's/^GIT_AUTHOR_EMAIL=//')

if [ -n "$INLINE_NAME" ] || [ -n "$INLINE_EMAIL" ]; then
  AUTHOR_NAME="$INLINE_NAME"
  AUTHOR_EMAIL="$INLINE_EMAIL"
else
  # git var GIT_AUTHOR_IDENT resolves env overrides already present in this
  # hook's own environment, falling back to repo/global config — same
  # resolution husky's commit-msg hook relies on.
  AUTHOR_IDENT=$(git "${GIT_DIR_ARG[@]}" var GIT_AUTHOR_IDENT 2>/dev/null)
  AUTHOR_NAME=${AUTHOR_IDENT%% <*}
  AUTHOR_EMAIL=$(printf '%s' "$AUTHOR_IDENT" | sed -n 's/.*<\(.*\)>.*/\1/p')
fi

if case_insensitive_match "$AUTHOR_NAME" "$CLAUDE_PATTERN" \
  || case_insensitive_match "$AUTHOR_EMAIL" "$CLAUDE_PATTERN"; then
  cat >&2 <<MSG
BLOCKED: commit author would be '$AUTHOR_NAME <$AUTHOR_EMAIL>'.
Commits must be authored by the human user; Claude belongs ONLY in a
'Co-Authored-By:' trailer (see feedback_commit_author_is_user_not_agent_role).
Fix the identity before committing:
  git ${GIT_DIR_ARG[@]:+-C "$C_PATH" }config user.name  "<the human's name>"
  git ${GIT_DIR_ARG[@]:+-C "$C_PATH" }config user.email "<the human's email>"
and end the commit message with:
  Co-Authored-By: Claude <noreply@anthropic.com>
MSG
  exit 2
fi

exit 0
