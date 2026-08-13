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
# uncommitted tracked changes it WARNS and exits 0 without touching anything.
# (Agents shouldn't be editing /workspace directly anyway; that's what worktrees
# are for.)
#
# DISPOSABLE-DIVERGENCE AUTO-RESET (task #75): when the ff-only fails because
# local main DIVERGED (has commits origin/main lacks), the script resets to
# origin/main ONLY when every divergent commit is provably disposable — either
# already-landed upstream by content (`git cherry` patch-id match) or touching
# ONLY baseline/benchmark-result JSON, run logs, or live team-memory. If ANY
# divergent commit carries real work (src/tests/plan/scripts/…), it refuses and
# surfaces for manual resolution — it never discards real local work. This fixes
# the recurring stale-/workspace problem where a superseded merge-queue baseline
# commit or a worktree branch-rename left main diverged and the sync silently
# gave up (the lead had to `git reset --hard origin/main` ~4×/session).
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

# SINGLE-FLIGHT: this script is wired into SessionStart AND Stop hooks, so
# concurrent invocations are routine (every agent stop fires one). Without a
# lock they stack: on 2026-08-08 seven overlapping runs each spawned the full
# pre-push verification chain and drove load to 29 on 8 cores. One sync at a
# time; a second concurrent run has nothing new to do anyway.
exec 9>"$WS/.git/sync-workspace-main.lock" 2>/dev/null || exit 0
if ! flock -n 9; then say "another sync in progress — skipping"; exit 0; fi

# Keep the FORK's main synced with upstream (clean fast-forward ONLY). Agents
# branch from origin/main and the statusline reads /workspace, so when the fork
# (origin = ttraenkler/js2) lags upstream (loopdive/js2wasm — where PRs actually
# merge) everything downstream silently rots: stale-base PRs go DIRTY, the
# id-allocator collides, the statusline shows an old sprint. This advances
# origin/main to upstream/main ONLY when origin is a strict ANCESTOR of upstream
# (a real fast-forward) — never a force/rewrite (public main is append-only),
# and a no-op when already current or when origin has its own commits.
if git -C "$WS" remote get-url upstream >/dev/null 2>&1 \
   && git -C "$WS" fetch upstream main --quiet 2>/dev/null; then
  o=$(git -C "$WS" rev-parse origin/main 2>/dev/null)
  u=$(git -C "$WS" rev-parse upstream/main 2>/dev/null)
  if [ -n "$o" ] && [ -n "$u" ] && [ "$o" != "$u" ] \
     && git -C "$WS" merge-base --is-ancestor "$o" "$u" 2>/dev/null; then
    # --no-verify: this mirror push carries only upstream-merged, CI-validated
    # commits — the local pre-push chain (typecheck+lint+tests, ~5 min) adds
    # nothing and made every Stop-hook invocation cost a full verification run
    # (the 2026-08-08 load-29 pileup). Sanctioned for pushes by the hook's own
    # header and CLAUDE.md; CI runs the real gate.
    if git -C "$WS" push origin "$u:refs/heads/main" --quiet --no-verify 2>/dev/null; then
      say "synced fork origin/main -> upstream/main ($(echo "$u" | cut -c1-9))"
    else
      say "WARNING: upstream->origin/main fast-forward push failed (perms/protection?)"
    fi
  fi
fi

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
  exit 0
fi

# ── Disposable-divergence auto-reset (task #75) ─────────────────────────────
# The ff-only above failed: local main has commit(s) that are NOT ancestors of
# origin/main (it DIVERGED, not merely lagged). This recurs because /workspace
# main occasionally lands on a commit that origin/main later supersedes — most
# often a github-actions[bot] baseline-refresh (`benchmarks/results/*`) the merge
# queue produced, or a worktree branch-rename that left main on a feature-branch
# tip. Those divergent commits carry NO real un-pushed work, so the safe recovery
# is `reset --hard origin/main` — but ONLY when EVERY divergent commit is provably
# disposable. If even one carries real work, refuse and surface (never discard).
#
# A divergent commit is DISPOSABLE iff either:
#   (a) its content already landed on origin/main under a different SHA — i.e.
#       `git cherry` marks it `-` (squash/rebase-merged; patch-id equivalent); or
#   (b) it touches ONLY throwaway/auto-generated paths (baseline + benchmark
#       result JSON, run logs, live team-memory) — never src/tests/plan/etc.
divergent=$(git -C "$WS" rev-list origin/main..HEAD 2>/dev/null)
if [ -z "$divergent" ]; then
  # No divergent commits yet ff-only still failed (e.g. a stray detached/odd
  # state) — surface rather than guess.
  say "WARNING: cannot fast-forward but no divergent commits found — left at $local_sha. Resolve manually."
  exit 0
fi

# `git cherry` prefixes `-` for commits whose patch-id is already upstream, `+`
# for genuinely-new ones. Collect the SHAs still marked `+` (not yet landed).
unlanded=$(git -C "$WS" cherry origin/main HEAD 2>/dev/null | sed -n 's/^+ //p')

# Disposable-path allowlist (anchored): a `+` commit is still disposable if every
# file it touches matches one of these prefixes. Anything else (src/, tests/,
# plan/, scripts/, .github/, docs/, …) is real work → refuse.
is_disposable_paths() {
  # $1 = commit sha; returns 0 (true) iff ALL changed paths are disposable.
  files=$(git -C "$WS" diff-tree --no-commit-id --name-only -r "$1" 2>/dev/null)
  [ -n "$files" ] || return 1 # empty/merge commit — treat as non-disposable (surface)
  printf '%s\n' "$files" | while IFS= read -r f; do
    case "$f" in
      benchmarks/results/* | public/benchmarks/* | website/public/benchmarks/* \
        | website/benchmarks/* | runs/* | .claude/memory/*) : ;;
      *) echo "REAL"; break ;;
    esac
  done | grep -q REAL && return 1
  return 0
}

all_disposable=1
for sha in $unlanded; do
  if ! is_disposable_paths "$sha"; then
    all_disposable=0
    break
  fi
done

if [ "$all_disposable" -eq 1 ]; then
  ndiv=$(printf '%s\n' "$divergent" | grep -c .)
  if git -C "$WS" reset --hard origin/main >/dev/null 2>&1; then
    say "diverged on $ndiv disposable commit(s) (already-landed and/or baseline/benchmark/memory-only) — reset $local_sha -> $main_sha"
  else
    say "WARNING: disposable-divergence reset to origin/main FAILED — left at $local_sha. Resolve manually."
  fi
else
  say "WARNING: cannot fast-forward — local main has divergent commit(s) with REAL work (not baseline/benchmark/memory). Left at $local_sha. Resolve manually."
fi
exit 0
