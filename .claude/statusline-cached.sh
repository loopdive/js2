#!/usr/bin/env bash
# Fast, always-answering wrapper around .claude/statusline-command.sh
#
# WHY (2026-07-26): the real statusline renderer takes 6.5-7.2s on this repo
# under agent load (it does several git operations over ~3,200 issue files;
# the script's own comments note `git show` costs ~13s here). Claude Code
# drops a statusline command that exceeds its internal timeout, so the
# statusline silently DISAPPEARS -- which is exactly what happened.
#
# This wrapper never blocks: it prints the last rendered line immediately and
# refreshes in the background. Worst case the line is up to MAX_AGE seconds
# stale, which is invisible next to a 30s refreshInterval; best case the
# statusline is simply always there.
#
# Failure mode by design: if no cache exists yet, print nothing and exit 0
# rather than stall the UI. The first background refresh populates it.

set -uo pipefail

DIR="${HOME}/.cache/js2-statusline"
CACHE="${DIR}/line"
LOCK="${DIR}/refresh.lock"
STDIN_SNAP="${DIR}/stdin.json"
# Refresh no more often than this. The underlying renderer costs ~7s of git
# work per run, so refreshing every 25-30s burned ~25% of a core CONTINUOUSLY
# on a box that is already CPU-bound. At 150s that drops to ~5%, and the
# displayed numbers (sprint counts, test262 %, free RAM) move far slower than
# that anyway.
MAX_AGE=150

mkdir -p "$DIR" 2>/dev/null || true

# Claude Code feeds session JSON on stdin. Snapshot it so the background
# refresh gets the same input we were called with.
if [ ! -t 0 ]; then
  cat >"${STDIN_SNAP}.tmp" 2>/dev/null && mv -f "${STDIN_SNAP}.tmp" "$STDIN_SNAP" 2>/dev/null
fi

# 1. Answer immediately from cache, if we have anything at all.
if [ -s "$CACHE" ]; then
  cat "$CACHE"
fi

# 2. Decide whether a refresh is due.
need_refresh=1
if [ -s "$CACHE" ]; then
  now=$(date +%s)
  mtime=$(stat -c %Y "$CACHE" 2>/dev/null || echo 0)
  if [ $((now - mtime)) -lt "$MAX_AGE" ]; then
    need_refresh=0
  fi
fi

# 3. Refresh in the background, at most one at a time.
#    mkdir is the atomic lock primitive; stale locks are cleared after 180s.
if [ "$need_refresh" = "1" ]; then
  if [ -d "$LOCK" ]; then
    lock_mtime=$(stat -c %Y "$LOCK" 2>/dev/null || echo 0)
    if [ $(($(date +%s) - lock_mtime)) -gt 180 ]; then rmdir "$LOCK" 2>/dev/null || true; fi
  fi
  if mkdir "$LOCK" 2>/dev/null; then
    (
      trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT
      real="$(dirname "$0")/statusline-command.sh"
      [ -x "$real" ] || exit 0
      out=$(timeout 60 bash "$real" <"$STDIN_SNAP" 2>/dev/null)
      # Only overwrite on a non-empty render, so a failed refresh keeps the
      # last good line rather than blanking the statusline.
      if [ -n "$out" ]; then
        printf '%s' "$out" >"${CACHE}.tmp" && mv -f "${CACHE}.tmp" "$CACHE"
      fi
    ) >/dev/null 2>&1 &
    disown 2>/dev/null || true
  fi
fi

exit 0
