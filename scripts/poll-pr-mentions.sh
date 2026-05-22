#!/usr/bin/env bash
# poll-pr-mentions.sh — watches open PRs for main-branch drift. Emits one
# line per (PR, main-sha) pair the first time the PR is observed drifted,
# so a Claude Code Monitor or tmux pane surfaces it to the tech lead.
#
# Replaces the older "watch for @claude PR comments" design — the strict
# required-status-checks policy + merge-queue batch=1 means GitHub itself
# bounces drifted PRs; this script just makes that visible.
#
# Single-instance enforced via flock on a lock file.
# Per-PR/main-sha dedup so we don't re-alert until either main moves OR
# the PR base catches up.
#
# Usage:
#   scripts/poll-pr-mentions.sh                 # default: poll every 60s
#   INTERVAL_SECS=30 scripts/poll-pr-mentions.sh
#   NTFY_URL=https://ntfy.sh/your-topic scripts/poll-pr-mentions.sh
#
# State files:
#   $STATE_FILE   — JSON map of {pr_number: "last-alerted-main-sha"}
#   $LOCK_FILE    — flock target; exit if already locked.

set -euo pipefail

REPO="${REPO:-loopdive/js2wasm}"
INTERVAL_SECS="${INTERVAL_SECS:-60}"
STATE_FILE="${STATE_FILE:-${HOME}/.cache/poll-pr-drift-state.json}"
LOCK_FILE="${LOCK_FILE:-/tmp/poll-pr-mentions.lock}"
# Optional ntfy URL — when set, the script POSTs a short notification per
# new drift event so the user gets a phone push regardless of whether a
# Claude session is watching this script's stdout.
NTFY_URL="${NTFY_URL:-}"

mkdir -p "$(dirname "$STATE_FILE")"
[ -f "$STATE_FILE" ] || echo '{}' > "$STATE_FILE"

# ---- single-instance lock ----------------------------------------------------
# flock -n: non-blocking. If another instance holds the lock, exit immediately.
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "[poll-pr-mentions] another instance is already running (lock: $LOCK_FILE) — exiting"
  exit 0
fi
echo "$$" >&9

trap 'rm -f "$LOCK_FILE"; exit 0' INT TERM EXIT

echo "[poll-pr-mentions] watching $REPO for main-branch drift (every ${INTERVAL_SECS}s)"
echo "  state: $STATE_FILE"
echo "  lock:  $LOCK_FILE (pid $$)"

# ---- main loop ---------------------------------------------------------------
while true; do
  MAIN_HEAD=$(gh api "repos/$REPO/branches/main" --jq '.commit.sha' 2>/dev/null || echo "")
  if [ -z "$MAIN_HEAD" ]; then
    sleep "$INTERVAL_SECS"
    continue
  fi

  # List open PRs targeting main with auto-merge enabled — these are queue
  # candidates. For each, fetch base.sha and check drift.
  gh api "repos/$REPO/pulls?state=open&base=main&per_page=100" --paginate 2>/dev/null \
    | jq -c '.[] | select(.auto_merge != null) | {number, base: .base.sha, title}' \
    | while IFS= read -r pr; do
        number=$(echo "$pr" | jq -r '.number')
        base=$(echo "$pr" | jq -r '.base')
        title=$(echo "$pr" | jq -r '.title' | head -c 80)

        # Skip if base already at main HEAD — no drift.
        [ "$base" = "$MAIN_HEAD" ] && continue

        # Skip if we've already alerted for this (PR, MAIN_HEAD) pair.
        last_alerted=$(jq -r --arg n "$number" '.[$n] // ""' "$STATE_FILE")
        [ "$last_alerted" = "$MAIN_HEAD" ] && continue

        # Count non-[skip ci] commits between base and main HEAD.
        drift=$(gh api "repos/$REPO/compare/$base...$MAIN_HEAD" \
                  --jq '[.commits[] | select(.commit.message | contains("[skip ci]") | not)] | length' \
                  2>/dev/null || echo 0)
        [ "$drift" -lt 1 ] && continue

        ts=$(date -u +%H:%M:%SZ)
        echo "[$ts] PR #$number drifted: $drift commits behind main (${MAIN_HEAD:0:9}) — $title"

        if [ -n "$NTFY_URL" ]; then
          curl -fsS -m 5 -X POST \
            -H "Title: PR #$number drifted" \
            -H "Priority: default" \
            -d "$drift commits behind main — $title" \
            "$NTFY_URL" >/dev/null 2>&1 || true
        fi

        # Record alert so we don't re-emit until main moves.
        tmp=$(mktemp)
        jq --arg n "$number" --arg s "$MAIN_HEAD" '. + {($n): $s}' "$STATE_FILE" > "$tmp"
        mv "$tmp" "$STATE_FILE"
      done

  # Prune state entries for PRs that are now closed/merged, so the file
  # doesn't grow unbounded. (Optional — drop a "GC every Nth iteration"
  # pattern later if needed; the file is small.)
  sleep "$INTERVAL_SECS"
done
