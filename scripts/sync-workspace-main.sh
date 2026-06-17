#!/bin/sh
# Fast-forward the /workspace main checkout to origin/main.
#
# Why: agents work in worktrees branched from origin/main, so the /workspace
# checkout itself never advances on its own and silently rots behind main
# (it was 135 commits behind on 2026-05-29, which made the statusline report
# a stale sprint off the old local tree). Run this after every PR merge so
# the shared checkout — and everything that reads it (statusline, fresh
# worktree bases, dashboards) — stays current.
#
# SAFE BY DESIGN: only fast-forwards a CLEAN checkout. If /workspace has
# uncommitted tracked changes or has diverged, it WARNS and exits 0 without
# touching anything — it never discards local work. (Agents shouldn't be
# editing /workspace directly anyway; that's what worktrees are for.)
#
# EXCEPTION: changes under .claude/memory/ are ignored by the dirty check.
# That dir is live team-memory the agents write continuously, so it is almost
# always dirty; incoming code commits never touch it, so a fast-forward stays
# safe. Without this exclusion the hook refused on every memory edit and
# /workspace silently rotted behind main (the very thing this script prevents).
# In the rare case an incoming commit DOES touch .claude/memory/ while the
# local copy is dirty, the `merge --ff-only` below fails safely and warns.
#
# Usage: scripts/sync-workspace-main.sh [workspace_dir]   (default /workspace)
set -u
WS="${1:-/workspace}"
say() { echo "[sync-workspace-main] $*"; }

[ -d "$WS/.git" ] || { say "no git repo at $WS — skipping"; exit 0; }

git -C "$WS" fetch origin main --quiet 2>/dev/null || { say "fetch failed — skipping"; exit 0; }

local_sha=$(git -C "$WS" rev-parse --short HEAD 2>/dev/null)
main_sha=$(git -C "$WS" rev-parse --short origin/main 2>/dev/null)
[ "$local_sha" = "$main_sha" ] && { say "already current ($local_sha)"; exit 0; }

cur_branch=$(git -C "$WS" rev-parse --abbrev-ref HEAD 2>/dev/null)
if [ "$cur_branch" != "main" ]; then
  say "checkout is on '$cur_branch', not main — skipping (won't switch branches)"; exit 0
fi

# Refuse to touch a dirty tree — surface, don't discard. EXCEPTION: ignore
# changes under .claude/memory/ (see header) so the hook isn't permanently
# blocked by live team-memory writes.
if ! git -C "$WS" diff --quiet -- . ':(exclude).claude/memory' 2>/dev/null \
   || ! git -C "$WS" diff --cached --quiet -- . ':(exclude).claude/memory' 2>/dev/null; then
  say "WARNING: $WS has uncommitted changes outside .claude/memory/ — NOT syncing (commit/clean it, then rerun)."
  exit 0
fi

if git -C "$WS" merge --ff-only origin/main >/dev/null 2>&1; then
  say "fast-forwarded $local_sha -> $main_sha"
else
  say "WARNING: cannot fast-forward (diverged?) — left at $local_sha. Resolve manually."
fi
exit 0
