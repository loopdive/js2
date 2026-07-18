#!/bin/bash
# Pre-push LOC-regrowth ratchet check (#3102/#3131).
#
# WHY a Claude Code PreToolUse hook and not (only) a husky git hook: pushes here
# routinely use `git push --no-verify` (sanctioned — the husky pre-push integrity
# gate chokes on the fork/upstream divergence), which SKIPS husky hooks entirely.
# This interceptor fires on the git-push tool-call itself, so `--no-verify` can't
# bypass it — it catches the LOC-ratchet failure locally, before a CI round-trip.
#
# SAFETY: this only ever BLOCKS on the exact change-scoped regrowth signature and
# FAILS OPEN on anything else (unresolved dir, script/runtime error, ambiguous
# output). A hook bug can never wedge a push. Escape hatch: prefix the push with
# `LOC_BUDGET_SKIP=1` for the rare legitimate case.

INPUT=$(cat)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)
[ -z "$CMD" ] && exit 0

# Explicit escape hatch.
echo "$CMD" | grep -q 'LOC_BUDGET_SKIP' && exit 0

# Only act on a `git push` to a PR-bound remote (fork / origin). Skip labs,
# tag-only pushes to other remotes, and every non-push command.
echo "$CMD" | grep -qE '\bgit +push\b' || exit 0
echo "$CMD" | grep -qE '\b(fork|origin)\b' || exit 0

# Resolve the working dir the push runs in: honor a leading `cd <dir> && …`
# (the repo's worktree convention), else the current shell PWD.
WORKDIR=$(printf '%s\n' "$CMD" | sed -nE 's/^[[:space:]]*cd[[:space:]]+([^ &]+).*/\1/p' | head -1)
[ -z "$WORKDIR" ] && WORKDIR="$PWD"
# Fail open if we can't resolve a real checkout with the check script.
[ -f "$WORKDIR/scripts/check-loc-budget.mjs" ] || exit 0

# Run the change-scoped check IN that worktree (same invocation CI uses). It
# resolves the merge-base with origin/main and flags only THIS branch's god-file
# regrowth. Capture output; never let a runtime error here block the push.
OUT=$(cd "$WORKDIR" 2>/dev/null && node scripts/check-loc-budget.mjs 2>&1)

# BLOCK only on the precise regrowth signature — fail open otherwise so a
# whole-tree-fallback or a transient error can't false-block.
if printf '%s' "$OUT" | grep -qiE 'God-files grown past|LOC budget gate FAILED'; then
  {
    echo "BLOCKED: the LOC-regrowth ratchet (#3102/#3131) would FAIL in CI — fix before pushing."
    echo "---------------------------------------------------------------------------"
    printf '%s\n' "$OUT" | grep -iA6 -E 'God-files grown past|LOC budget gate FAILED' | head -12
    echo "---------------------------------------------------------------------------"
    echo "Fix: add the code to the subsystem module (not the god-file/barrel), OR grant"
    echo "THIS change-set an allowance — list the path(s) under a 'loc-budget-allow:' key in"
    echo "the YAML frontmatter of the PR's own plan/issues/*.md file. Do NOT commit changes"
    echo "to scripts/loc-budget-baseline.json (refreshed post-merge on main only)."
    echo "Then re-push. Escape (rare, if you're certain): prefix with LOC_BUDGET_SKIP=1."
  } >&2
  exit 2
fi

exit 0
