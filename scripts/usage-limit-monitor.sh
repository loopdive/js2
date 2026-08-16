#!/usr/bin/env bash
# usage-limit-monitor.sh — per-minute usage-window watchdog (#4511)
#
# Reads the statusline budget cache (~/.claude/js2wasm-budget.json) every
# minute. When any rate-limit window reaches the suspend threshold (default
# 99%), it raises a suspend sentinel (~/.claude/usage-limit-suspend.json)
# carrying the window's reset timestamp; when usage drops (new window), it
# clears the sentinel. The PreToolUse hook in .claude/settings.json denies
# new Agent spawns while the sentinel is live, which surfaces the suspend
# order — "suspend the team, schedule ONE wakeup at the reset" — to the lead
# in-band (feedback_5h_window_pause_resume).
#
# HONESTY CONSTRAINT: the cache is written only when the statusline renders
# (interactive sessions). Headless sessions never refresh it, so this monitor
# DEGRADES TO NO-SIGNAL there — it logs that state explicitly and never
# fabricates a percentage. A detector must be able to say "I don't know";
# the fallback in no-signal sessions remains the documented limit-error
# handling (agents dying with "hit your limit · resets HH:MM").
#
# Usage:
#   usage-limit-monitor.sh            # launch singleton daemon (no-op if running)
#   usage-limit-monitor.sh --once     # single evaluation, for tests/hooks
#   usage-limit-monitor.sh --daemon   # internal: the loop itself
set -u

CLAUDE_HOME="${CLAUDE_HOME:-$HOME/.claude}"
CACHE="$CLAUDE_HOME/js2wasm-budget.json"
SENTINEL="$CLAUDE_HOME/usage-limit-suspend.json"
PIDFILE="$CLAUDE_HOME/usage-limit-monitor.pid"
LOG="$CLAUDE_HOME/usage-limit-monitor.log"
THRESHOLD="${USAGE_LIMIT_SUSPEND_PCT:-99}"
INTERVAL="${USAGE_LIMIT_POLL_SEC:-60}"
MAX_CACHE_AGE="${USAGE_LIMIT_MAX_CACHE_AGE_SEC:-600}"

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$1" >>"$LOG"; }

evaluate_once() {
  local now pct window resets written age state_file="$CLAUDE_HOME/.usage-limit-monitor.state"
  local prev="" state=""
  [ -f "$state_file" ] && prev=$(cat "$state_file" 2>/dev/null)
  now=$(date +%s)

  if [ ! -f "$CACHE" ]; then
    state="nosignal-absent"
    [ "$prev" != "$state" ] && log "NO-SIGNAL: cache absent ($CACHE) — statusline not rendering in this session; detection degraded to limit-error signals"
  else
    written=$(jq -r '.written_at // 0' "$CACHE" 2>/dev/null || echo 0)
    age=$((now - ${written%.*}))
    if [ "$age" -gt "$MAX_CACHE_AGE" ]; then
      state="nosignal-stale"
      [ "$prev" != "$state" ] && log "NO-SIGNAL: cache is ${age}s old (> ${MAX_CACHE_AGE}s) — treating as unknown, not as healthy"
    else
      # Prefer the tighter 5h window; fall back to weekly.
      pct=$(jq -r '.five_hour_used_pct // empty' "$CACHE" 2>/dev/null)
      window="five_hour"
      resets=$(jq -r '.five_hour_resets_at // empty' "$CACHE" 2>/dev/null)
      wk=$(jq -r '.seven_day_used_pct // empty' "$CACHE" 2>/dev/null)
      if [ -n "$wk" ] && { [ -z "$pct" ] || awk -v a="$wk" -v b="${pct:-0}" 'BEGIN{exit !(a>b)}'; }; then
        if awk -v a="$wk" -v t="$THRESHOLD" 'BEGIN{exit !(a>=t)}'; then
          pct="$wk"; window="seven_day"
          resets=$(jq -r '.resets_at // empty' "$CACHE" 2>/dev/null)
        fi
      fi
      if [ -n "${pct:-}" ] && awk -v a="$pct" -v t="$THRESHOLD" 'BEGIN{exit !(a>=t)}'; then
        state="suspend"
        if [ "$prev" != "$state" ]; then
          printf '{"window":"%s","used_pct":%s,"resets_at":%s,"written_at":%s}\n' \
            "$window" "$pct" "${resets:-null}" "$now" >"$SENTINEL"
          log "SUSPEND: $window at ${pct}% >= ${THRESHOLD}% — sentinel raised (resets_at=${resets:-unknown})"
        fi
      else
        state="clear"
        if [ -f "$SENTINEL" ]; then
          rm -f "$SENTINEL"
          log "CLEAR: usage below threshold (five_hour=${pct:-n/a}) — sentinel removed"
        fi
      fi
    fi
  fi
  printf '%s' "$state" >"$state_file"
}

case "${1:-}" in
  --daemon)
    log "monitor daemon started (pid $$, threshold ${THRESHOLD}%, interval ${INTERVAL}s)"
    while true; do
      evaluate_once
      sleep "$INTERVAL"
    done
    ;;
  --once)
    evaluate_once
    ;;
  *)
    if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null; then
      exit 0
    fi
    nohup bash "$0" --daemon >/dev/null 2>&1 &
    echo $! >"$PIDFILE"
    exit 0
    ;;
esac
