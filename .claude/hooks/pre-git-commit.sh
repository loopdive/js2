#!/bin/bash
# Pre-commit hook: block dangerous patterns, inject checklist as guidance
# Lightweight — no sign-off ceremony, just safety checks + context injection

INPUT=$(cat)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)
if [ -z "$CMD" ]; then
  exit 0
fi

# Block git add -A, git add --all, git add . (only bare dot as sole arg)
FIRST_LINE=$(echo "$CMD" | head -1)
if echo "$FIRST_LINE" | grep -qE '^git add (-A|--all|\.)$|^git add (-A|--all|\.) '; then
  echo "BLOCKED: Never use 'git add -A', 'git add --all', or 'git add .' — stage specific files only." >&2
  exit 2
fi

# Block committing/merging/pushing on main from wrong directory.
# Scoped to git state-changing ops only (its stated intent) so it doesn't
# block unrelated commands (gh/npx/pwd/cd) run from a scratch subdir like .tmp/.
BRANCH=$(git branch --show-current 2>/dev/null)
if [ "$BRANCH" = "main" ] && [ "$PWD" != "${CLAUDE_PROJECT_DIR:-/workspace}" ] && echo "$FIRST_LINE" | grep -qE '^git (commit|merge|push|add)\b'; then
  echo "BLOCKED: On main but pwd is $PWD (not the repo root). Are you in a worktree?" >&2
  exit 2
fi

# For git commit: check checklist sign-off and inject guidance
# NOTE: formatting + linting now handled by husky + lint-staged (git pre-commit hook)
if echo "$CMD" | grep -q 'git commit'; then
  # Verify checklist sign-off: end the commit message with a ✓ checkmark once you've
  # completed plan/method/pre-commit-checklist.md.
  if ! echo "$CMD" | grep -q '✓'; then
    echo "BLOCKED: Missing checklist sign-off. End your commit message with a ✓ once you've completed plan/method/pre-commit-checklist.md." >&2
    exit 2
  fi
  CHECKLIST=$(head -15 "${CLAUDE_PROJECT_DIR:-/workspace}"/plan/method/pre-commit-checklist.md 2>/dev/null)
  if [ -n "$CHECKLIST" ]; then
    jq -n --arg ctx "VERIFY BEFORE COMMITTING: pwd=$(pwd) branch=$BRANCH. Have you checked: specific files staged? diff reviewed? no accidental deletions?" \
      '{hookSpecificOutput: {hookEventName: "PreToolUse", additionalContext: $ctx}}'
  fi
fi

exit 0
