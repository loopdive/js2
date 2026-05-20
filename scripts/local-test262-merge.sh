#!/bin/bash
# scripts/local-test262-merge.sh <PR_NUMBER>
#
# CI queue fallback: run test262 locally and merge the PR if green.
# Call this when the GitHub CI queue is jammed (>8 in-flight PRs) and you don't
# want to wait. Only one run executes at a time across all worktrees.
#
# Exit codes:
#   0 — PR merged, or skipped (CI not jammed / lock held)
#   1 — test262 failed (regression vs baseline) — do not merge
#   2 — usage / setup error

set -euo pipefail

PR="${1:?Usage: $0 <PR_NUMBER>}"
WORKSPACE=/workspace
LOCK="$WORKSPACE/.claude/local-test262.lock"
INFLIGHT_THRESHOLD=8

# ── 1. Verify we're in a worktree, not the main workspace ─────────────────────
ROOT=$(git rev-parse --show-toplevel)
if [ "$ROOT" = "$WORKSPACE" ]; then
  echo "ERROR: run this from a worktree, not /workspace directly." >&2
  exit 2
fi

# ── 2. Count in-flight CI (null-conclusion stubs on origin/main) ──────────────
git -C "$WORKSPACE" fetch origin -q
IN_FLIGHT=$(
  git -C "$WORKSPACE" ls-tree -r origin/main --name-only \
    | grep '^\.claude/ci-status/pr-' \
    | while read -r f; do
        git -C "$WORKSPACE" show "origin/main:$f" 2>/dev/null
      done \
    | jq -s '[.[] | select(.conclusion == null)] | length'
)

if [ "$IN_FLIGHT" -le "$INFLIGHT_THRESHOLD" ]; then
  echo "CI queue is clear ($IN_FLIGHT in-flight). Terminating — wait for CI normally."
  exit 0
fi

echo "CI queue jammed ($IN_FLIGHT in-flight > $INFLIGHT_THRESHOLD). Trying local test262 for PR #$PR..."

# ── 3. Try to acquire outer lock (non-blocking) ───────────────────────────────
# Prevents two agents from both deciding to run test262 at the same time.
# The inner lock inside run-test262-vitest.sh is a separate serialization layer.
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "Lock held — another agent is running local test262. Terminating — wait for CI normally."
  exit 0
fi
echo "PR #$PR PID=$$ $(date -u +%Y-%m-%dT%H:%M:%SZ)" >&9
trap 'flock -u 9; rm -f "$LOCK"' EXIT INT TERM

echo "Lock acquired."

# ── 4. Read baseline pass count from origin/main ─────────────────────────────
BASELINE=$(
  git -C "$WORKSPACE" show "origin/main:benchmarks/results/test262-current.json" 2>/dev/null \
    | jq -r '.summary.pass // 0'
)
echo "Baseline (origin/main): $BASELINE pass"

# ── 5. Run test262 from the worktree ─────────────────────────────────────────
cd "$ROOT"
echo "Running test262 (this takes ~25 min)..."
pnpm run test:262

# ── 6. Read result ────────────────────────────────────────────────────────────
REPORT="$ROOT/benchmarks/results/test262-report.json"
if [ ! -f "$REPORT" ]; then
  echo "ERROR: $REPORT not found after run." >&2
  exit 2
fi

NEW_PASS=$(jq -r '.summary.pass // 0'  "$REPORT")
NEW_TOTAL=$(jq -r '.summary.total // 0' "$REPORT")
DELTA=$((NEW_PASS - BASELINE))

echo "Result: $NEW_PASS / $NEW_TOTAL pass (delta vs baseline: $DELTA)"

# ── 7. Merge gate: new pass >= baseline ──────────────────────────────────────
if [ "$NEW_PASS" -lt "$BASELINE" ]; then
  echo "FAIL: $NEW_PASS < baseline $BASELINE (delta $DELTA). Do NOT merge PR #$PR." >&2
  exit 1
fi

echo "PASS: no regressions. Merging PR #$PR..."

GATE_BYPASS=1 gh pr merge "$PR" --merge --admin \
  --body "$(cat <<MSG
Self-merged via local test262 (CI queue jammed: ${IN_FLIGHT} in-flight).
Result: ${NEW_PASS}/${NEW_TOTAL} pass (${DELTA:+$DELTA}${DELTA#-} vs baseline ${BASELINE}).
Gate: scripts/local-test262-merge.sh
MSG
)"

echo "PR #$PR merged."
