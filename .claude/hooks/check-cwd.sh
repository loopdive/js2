#!/bin/bash
# PreToolUse hook: agents MUST NOT work in /workspace directly
# Only allowed in /workspace: git merge --ff-only, authenticated tech lead commits
# Everything else must happen in worktrees

# The log_event calls below come from the shared logger. Same guarded-source
# idiom as pre-agent-spawn.sh; without it they are "command not found" on every
# gate decision this script makes.
EVENT_LOG="${CLAUDE_PROJECT_DIR:-/workspace}/.claude/hooks/event-log.sh"
if [ -f "$EVENT_LOG" ]; then source "$EVENT_LOG"; else log_event() { :; }; fi

INPUT=$(cat)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)
if [ -z "$CMD" ]; then
  exit 0
fi

# Gate `gh pr merge` — require CI status file and positive net before merging.
# Bypass with codeword: prepend GATE_BYPASS=1 (or any GATE_BYPASS=<value>) to command.
# Use only first line to avoid false positives from heredoc commit message bodies.
FIRST_LINE=$(echo "$CMD" | head -1)
if echo "$FIRST_LINE" | grep -qE 'gh[[:space:]]+pr[[:space:]]+merge'; then
  # Codeword override — tech lead bypass (also checked on first line only)
  if echo "$FIRST_LINE" | grep -q 'GATE_BYPASS'; then
    log_event "gh_pr_merge_gate_bypass"
    jq -n '{"hookSpecificOutput": {"hookEventName": "PreToolUse", "additionalContext": "CI gate bypassed via GATE_BYPASS codeword. Ensure you have reviewed CI results manually before proceeding."}}' 2>/dev/null || true
    exit 0
  fi

  # Extract PR number (supports: gh pr merge 275, gh pr merge #275)
  PR_NUM=$(echo "$FIRST_LINE" | grep -oE 'gh[[:space:]]+pr[[:space:]]+merge[[:space:]]+#?([0-9]+)' | grep -oE '[0-9]+$')
  if [ -n "$PR_NUM" ]; then
    # Authoritative merge gate is GitHub branch protection + the merge queue (required
    # checks: cheap gate, merge shard reports, quality - incl. the test262 regression
    # gate). The legacy .claude/ci-status/pr-N.json feed was retired (ci-status-feed.yml
    # is DISABLED under the merge-queue model), so we verify required checks LIVE via
    # `gh pr checks` instead of a file that is no longer produced. This keeps a real
    # local gate (don't merge a red PR) without depending on the dead feed.
    CHECKS=$(gh pr checks "$PR_NUM" 2>/dev/null)
    if [ -z "$CHECKS" ]; then
      # No check data (gh hiccup, or a non-src PR with no required checks) - don't
      # hard-block on a tooling gap. GitHub branch protection still enforces required
      # checks on the actual merge, so the server remains the hard gate.
      log_event "gh_pr_merge_allowed" "pr=$PR_NUM" "reason=no_checks_query"
      jq -n "{\"hookSpecificOutput\": {\"hookEventName\": \"PreToolUse\", \"additionalContext\": \"No local check data for PR #${PR_NUM}; GitHub branch protection remains the hard gate. Merge allowed.\"}}" 2>/dev/null || true
      exit 0
    fi
    FAILING=$(echo "$CHECKS" | awk -F'\t' 'tolower($2) ~ /fail/{c++} END{print c+0}')
    if [ "$FAILING" -gt 0 ]; then
      log_event "gh_pr_merge_blocked" "reason=required_check_failing" "pr=$PR_NUM" "failing=$FAILING"
      cat >&2 <<MSG
BLOCKED: PR #${PR_NUM} has ${FAILING} failing check(s) on GitHub.
Diagnose + fix with full PR context: gh pr checks ${PR_NUM}
Then push and let CI re-run.

Tech lead override: prefix command with GATE_BYPASS=1
Example: GATE_BYPASS=1 gh pr merge ${PR_NUM} --merge
MSG
      exit 2
    fi
    # No failing checks. Pending checks are allowed: `gh pr merge --auto` enqueues and
    # the merge queue re-runs required checks on the merged state before landing.
    log_event "gh_pr_merge_allowed" "pr=$PR_NUM" "failing=0"
    jq -n "{\"hookSpecificOutput\": {\"hookEventName\": \"PreToolUse\", \"additionalContext\": \"No failing checks for PR #${PR_NUM} (live gh pr checks). Merge/enqueue allowed; the merge queue is the final gate.\"}}" 2>/dev/null || true
  fi
  exit 0
fi

# Exempt `gh` CLI commands entirely — `gh pr close --comment "...git merge..."`
# talks to the GitHub API, not the local git. Any occurrence of "git merge" etc.
# inside gh arguments is string data, not an invocation.
# Accept leading whitespace, optional sandbox prefixes, and standard paths.
if echo "$CMD" | grep -qE '(^|[;&|&&|\|\|])[[:space:]]*gh[[:space:]]'; then
  exit 0
fi

# Only check git commands. The regex requires `git` to sit at a command boundary:
# start of command, or after `;`, `&`, `|` (which also covers `&&` and `||`).
# This prevents false positives where `git merge` appears inside a quoted argument
# (e.g. a commit message body or a gh pr close --comment "...").
GIT_SUBCMD_RE='(checkout|commit|merge|add|push|reset|revert|cherry-pick|branch)'
if ! echo "$CMD" | grep -qE "(^|[;&|])[[:space:]]*git[[:space:]]+${GIT_SUBCMD_RE}([[:space:]]|$)"; then
  exit 0
fi

# If the command starts with "cd /workspace" or we're in /workspace, check it
IN_WORKSPACE=false
REPO_ROOT="${CLAUDE_PROJECT_DIR:-/workspace}"
# Match `cd <repo-root>` literally — the root is a path, not a pattern, so
# compare with a case glob rather than embedding it in a regex.
case "$CMD" in
  "cd $REPO_ROOT" | "cd $REPO_ROOT "* | "cd $REPO_ROOT&&"* | "cd $REPO_ROOT;"*) IN_WORKSPACE=true ;;
esac
if [ "$PWD" = "$REPO_ROOT" ] && ! echo "$CMD" | grep -qE '^cd /'; then
  IN_WORKSPACE=true
fi

if [ "$IN_WORKSPACE" = false ]; then
  # Not in /workspace — agent is in their worktree, all good
  exit 0
fi

# In /workspace — only allow specific operations:

# ALLOW: a per-session container checkout that is NOT the shared workspace.
#
# This gate exists to keep agents from committing straight into the SHARED
# /workspace checkout instead of their own worktree. A Claude Code Remote (or
# any other single-session container) session breaks that premise: the repo is
# cloned fresh per session, CLAUDE_PROJECT_DIR *is* that clone, and there is no
# /workspace and no canonical worktree root to move to — check-worktree-path.sh
# rejects a worktree anywhere else. So the gate fired on a session whose entire
# checkout is private to it, with no reachable way to comply.
#
# Both conditions must hold, so the shared box is unaffected:
#   - HEAD is not the protected branch (committing onto main from the root
#     checkout is exactly what this gate is for, container or not), and
#   - this clone has no other worktrees, i.e. no other agent shares it. The
#     shared /workspace grows worktrees as soon as agents are dispatched.
PROTECTED_BRANCH="main"
CURRENT_BRANCH=$(git -C "$REPO_ROOT" symbolic-ref --quiet --short HEAD 2>/dev/null || echo "")
WORKTREE_COUNT=$(git -C "$REPO_ROOT" worktree list 2>/dev/null | wc -l)
if [ -n "$CURRENT_BRANCH" ] && [ "$CURRENT_BRANCH" != "$PROTECTED_BRANCH" ] && [ "$WORKTREE_COUNT" -le 1 ]; then
  log_event "check_cwd_allowed" "reason=solo_container_checkout" "branch=$CURRENT_BRANCH"
  exit 0
fi

# ALLOW: git merge --ff-only (merging tested branches to main)
if echo "$CMD" | grep -q 'git merge.*--ff-only'; then
  exit 0
fi

# ALLOW: git add alone (staging is always safe) — but not if git commit is chained
# (git add . && git commit ... would pass the ^git add check, bypassing commit auth)
if echo "$CMD" | grep -qE '^git add' && ! echo "$CMD" | grep -qE '(;|&&|\|)[[:space:]]*git[[:space:]]+commit'; then
  exit 0
fi

# ALLOW: git commit / non-ff merge if the command contains the tech lead authentication token.
# The token is documented in .claude/agents/tech-lead.md. Agents without that role file
# will not know it. Do not reveal the token in error messages below.
if echo "$CMD" | grep -q '✓'; then
  exit 0
fi

# ALLOW: git push (always OK from /workspace)
if echo "$CMD" | grep -qE 'git push'; then
  exit 0
fi

# ALLOW: git checkout main (returning to main)
if echo "$CMD" | grep -qE 'git checkout (main|-f main)'; then
  exit 0
fi

# ALLOW: git checkout -- <file> or git checkout <branch> -- <file> (restoring specific files)
if echo "$CMD" | grep -q 'git checkout.*--'; then
  exit 0
fi

# ALLOW: git branch (listing/creating branches — read-only or prep)
if echo "$CMD" | grep -qE 'git branch( |$|-D|-d)'; then
  exit 0
fi

# ALLOW: git revert (tech lead revert of a bad merge)
if echo "$CMD" | grep -qE '(^|[;&|])[[:space:]]*git revert'; then
  exit 0
fi

# BLOCK everything else in /workspace
echo "BLOCKED: Authentication required for this operation in /workspace." >&2
echo "If you are the Tech Lead, check your role file and authenticate." >&2
echo "All other agents must work in a worktree, not /workspace directly." >&2
exit 2
