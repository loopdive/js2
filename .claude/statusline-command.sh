#!/bin/sh
input=$(cat)
cwd=$(echo "$input" | jq -r '.cwd // .workspace.current_dir // empty')
model_id=$(echo "$input" | jq -r '.model.id // empty')
ctx_size=$(echo "$input" | jq -r 'if .context_window.context_window_size then (.context_window.context_window_size as $s | if $s >= 1000000 then ($s / 1000000 | floor | tostring) + "M" else ($s / 1000 | floor | tostring) + "K" end) else empty end')
used=$(echo "$input" | jq -r '.context_window.used_percentage // empty')
weekly=$(echo "$input" | jq -r '.rate_limits.seven_day.used_percentage // empty')
five_hour=$(echo "$input" | jq -r '.rate_limits.five_hour.used_percentage // empty')
effort=$(echo "$input" | jq -r '.thinking.type // .effort.level // .effort // empty')
in_worktree=$(echo "$input" | jq -r '.worktree.path // empty')
worktree_branch=$(echo "$input" | jq -r '.worktree.branch // empty')
session_name=$(echo "$input" | jq -r '.session_name // empty')
pr_number=$(echo "$input" | jq -r '.pr.number // empty')
pr_state=$(echo "$input" | jq -r '.pr.review_state // empty')
output_style=$(echo "$input" | jq -r '.output_style.name // empty')
vim_mode=$(echo "$input" | jq -r '.vim.mode // empty')
agent_name=$(echo "$input" | jq -r '.agent.name // empty')
repo=$(echo "$input" | jq -r '.workspace.repo | if . then .owner + "/" + .name else empty end')
case "$model_id" in
  claude-fable-5*)    model='Fable 5';    price_in=15 ;;
  claude-mythos-5*)   model='Mythos 5';   price_in=15 ;;
  claude-opus-4-8*)   model='Opus 4.8';   price_in=15 ;;
  claude-opus-4-7*)   model='Opus 4.7';   price_in=15 ;;
  claude-opus-4-6*)   model='Opus 4.6';   price_in=15 ;;
  claude-sonnet-4-6*) model='Sonnet 4.6'; price_in=3  ;;
  claude-haiku-4-5*)  model='Haiku 4.5';  price_in=0  ;;
  claude-opus*)       model='Opus';       price_in=15 ;;
  claude-sonnet*)     model='Sonnet';     price_in=3  ;;
  claude-haiku*)      model='Haiku';      price_in=0  ;;
  *)                  model='';           price_in=0  ;;
esac
# 1M-context variant suffix (model id carries "1m", e.g. claude-opus-4-8[1m])
case "$model_id" in
  *1m*|*1M*) [ -n "$model" ] && model="$model 1M" ;;
esac
if [ "$price_in" -ge 5 ] 2>/dev/null; then   model_color='00;31'
elif [ "$price_in" -ge 1 ] 2>/dev/null; then  model_color='00;33'
else                                           model_color='00;32'
fi
branch=$(git -C "${cwd:-$(pwd)}" rev-parse --abbrev-ref HEAD 2>/dev/null)
issue=$(echo "$branch" | sed -n 's/^issue-\([a-zA-Z0-9]*\).*/\1/p')
# Base remote: 'upstream' if it exists, else 'origin'. Resolved once at startup.
_base_remote=$(git -C "${cwd:-$(pwd)}" remote 2>/dev/null | grep -Fx 'upstream' | head -1)
[ -z "$_base_remote" ] && _base_remote="origin"
_base_ref="${_base_remote}/main"
# Throttled background fetch: ensure the base ref stays reasonably fresh
# without ever blocking the render. If >180s since the last fetch, launch
# `git fetch` detached in the background (timeout 20s) and update the
# timestamp. The current render uses whatever objects are already cached.
_fetch_ts="${HOME}/.cache/js2-statusline/last-fetch"
_now_s=$(date +%s)
_do_fetch=1
if [ -f "$_fetch_ts" ]; then
  _last=$(cat "$_fetch_ts" 2>/dev/null)
  [ -n "$_last" ] && [ $(( _now_s - _last )) -lt 180 ] && _do_fetch=0
fi
if [ "$_do_fetch" = "1" ]; then
  mkdir -p "${HOME}/.cache/js2-statusline" 2>/dev/null
  printf '%s' "$_now_s" > "$_fetch_ts" 2>/dev/null
  (timeout 20 git -C "${cwd:-$(pwd)}" fetch --quiet "$_base_remote" main 2>/dev/null &) 2>/dev/null
fi
display_cwd=$(basename "${cwd:-$(pwd)}")
printf '\033[01;34m%s\033[00m' "$display_cwd"
# Model badge — before the ctx bar
[ -n "$model" ] && printf ' \033[%sm%s\033[00m' "$model_color" "$model"

# Agent PR badge — only shown when inside a worktree, for that worktree's own agent
status_dir="/workspace/.claude/agent-status"
if [ -d "$status_dir" ] && [ -n "$in_worktree" ]; then
  current_agent=$(basename "$in_worktree")
  f="$status_dir/${current_agent}.json"
  if [ -f "$f" ]; then
    now_sec=$(date +%s)
    state=$(jq -r '.state // empty' "$f" 2>/dev/null)
    if [ "$state" != "active" ]; then
      since=$(jq -r '.since // empty' "$f" 2>/dev/null)
      if [ -n "$since" ]; then
        elapsed=$(( now_sec - since ))
        [ "$elapsed" -lt 0 ] && elapsed=0
        if [ "$elapsed" -lt 60 ]; then age="${elapsed}s"
        elif [ "$elapsed" -lt 3600 ]; then age="$((elapsed / 60))m"
        else age="$((elapsed / 3600))h$((elapsed % 3600 / 60))m"; fi
        pr=$(jq -r '.pr // empty' "$f" 2>/dev/null)
        issue=$(jq -r '.issue // empty' "$f" 2>/dev/null)
        task=$(jq -r '.task // empty' "$f" 2>/dev/null)
        [ -n "$pr" ] && ref="#${pr}" || ref="${issue:-${task}}"
        [ -n "$ref" ] && label="${ref} ${age}" || label="${age}"
        # Freshness: use last_seen heartbeat if present, else fall back to since
        last_seen=$(jq -r '.last_seen // empty' "$f" 2>/dev/null)
        if [ -n "$last_seen" ]; then
          fresh=$(( now_sec - last_seen ))
          [ "$fresh" -lt 0 ] && fresh=0
          if [ "$fresh" -ge 600 ]; then   color="48;5;196;30"  # red: >10min since heartbeat = likely dead
          elif [ "$fresh" -ge 180 ]; then color="43;30"         # yellow: 3-10min = slow/lagging
          else                            color="42;30"; fi      # green: <3min = alive
        else
          # No heartbeat yet — fall back to time-in-state coloring
          if [ "$elapsed" -ge 900 ]; then   color="48;5;196;30"
          elif [ "$elapsed" -ge 300 ]; then color="43;30"
          else                              color="100;37"; fi
        fi
        printf ' \033[%sm %s \033[00m' "$color" "$label"
      fi
    fi
  fi
fi

# Days-left-in-week bar: derived from rate_limits.seven_day.resets_at (Unix ts).
# Computed here so it can be emitted right after the wkly bar below.
days_bar=""
resets_at=$(echo "$input" | jq -r '.rate_limits.seven_day.resets_at // empty')
if [ -n "$resets_at" ]; then
  now_sec=$(date +%s)
  remaining_sec=$((${resets_at%.*} - now_sec))
  if [ "$remaining_sec" -gt 0 ]; then
    days_left=$(awk "BEGIN {printf \"%.1f\", $remaining_sec / 86400}")
    days_int=$(awk "BEGIN {printf \"%d\", $remaining_sec / 86400}")
    elapsed_pct=$(awk "BEGIN {printf \"%.4f\", (7 - $remaining_sec / 86400) * 100 / 7}")
    days_bar=$(awk -v left="$days_left" -v days_int="$days_int" -v elapsed_pct="$elapsed_pct" 'BEGIN {
      if (days_int >= 4) {
        # Green zone: plain green text, no background bar — less salient
        printf " \033[32m%sd left\033[00m", left
      } else {
        if (days_int >= 2) { fill=43;         fg=30 }
        else               { fill="48;5;196"; fg=30 }
        width = 10
        filled = int(elapsed_pct * width / 100 + 0.5)
        label = sprintf(" %sd left", left)
        bar = ""
        for (i = 0; i < width; i++) bar = bar " "
        bar = label substr(bar, length(label) + 1)
        filled_part = substr(bar, 1, filled)
        empty_part  = substr(bar, filled + 1)
        printf " \033[%s;%sm%s\033[48;5;237;37m%s \033[00m", fill, fg, filled_part, empty_part
      }
    }' /dev/null)
  fi
fi

# Budget cache for budget-aware sprint scheduling (#2751) and the usage-limit
# monitor (#4511): standalone scripts (budget-status.mjs / freeze-sprint.mjs /
# usage-limit-monitor.sh) can't see this stdin JSON, so expose the weekly
# (seven_day) AND 5-hour usage% + reset timestamps to them via a small cache
# file the statusline keeps fresh on every render.
if [ -n "$weekly" ] || [ -n "$resets_at" ] || [ -n "$five_hour" ]; then
  _budget_dir="${CLAUDE_HOME:-$HOME/.claude}"
  _five_hour_resets=$(echo "$input" | jq -r '.rate_limits.five_hour.resets_at // empty')
  printf '{"seven_day_used_pct":%s,"resets_at":%s,"five_hour_used_pct":%s,"five_hour_resets_at":%s,"written_at":%s}\n' \
    "${weekly:-null}" "${resets_at:-null}" "${five_hour:-null}" "${_five_hour_resets:-null}" "$(date +%s)" \
    > "$_budget_dir/js2wasm-budget.json" 2>/dev/null || true
fi

if [ -n "$used" ] || [ -n "$weekly" ] || [ -n "$five_hour" ]; then
  if [ -n "$used" ]; then
    awk -v p="$used" 'BEGIN {
      if (p >= 75)      { fill="48;5;196"; fg=30 }
      else if (p >= 50) { fill=43; fg=30 }
      else              { fill=42; fg=30 }
      width = 9
      filled = int(p * width / 100)
      label = sprintf(" %d%% ctx", p)
      bar = ""
      for (i = 0; i < width; i++) bar = bar " "
      bar = label substr(bar, length(label) + 1)
      filled_part = substr(bar, 1, filled)
      empty_part  = substr(bar, filled + 1)
      printf " \033[%s;%sm%s\033[48;5;237;37m%s\033[00m", fill, fg, filled_part, empty_part
    }' /dev/null
  fi
  if [ -n "$five_hour" ] && [ -z "$in_worktree" ]; then
    awk -v p="$five_hour" 'BEGIN {
      if (p >= 75)      { fill="48;5;196"; fg=30 }
      else if (p >= 50) { fill=43; fg=30 }
      else              { fill=42; fg=30 }
      width = 8
      filled = int(p * width / 100)
      label = sprintf(" %d%% 5h", int(p))
      bar = ""
      for (i = 0; i < width; i++) bar = bar " "
      bar = label substr(bar, length(label) + 1)
      filled_part = substr(bar, 1, filled)
      empty_part  = substr(bar, filled + 1)
      printf " \033[%s;%sm%s\033[48;5;237;37m%s\033[00m", fill, fg, filled_part, empty_part
    }' /dev/null
  fi
  if [ -n "$weekly" ] && [ -z "$in_worktree" ]; then
    awk -v p="$weekly" 'BEGIN {
      if (p >= 75)      { fill="48;5;196"; fg=30 }
      else if (p >= 50) { fill=43; fg=30 }
      else              { fill=42; fg=30 }
      width = 10
      filled = int(p * width / 100)
      label = sprintf(" %d%% wkly", int(p))
      bar = ""
      for (i = 0; i < width; i++) bar = bar " "
      bar = label substr(bar, length(label) + 1)
      filled_part = substr(bar, 1, filled)
      empty_part  = substr(bar, filled + 1)
      printf " \033[%s;%sm%s\033[48;5;237;37m%s\033[00m", fill, fg, filled_part, empty_part
    }' /dev/null
    [ -n "$days_bar" ] && printf '%s' "$days_bar"
  fi
fi
# Test262 progress
report="/workspace/benchmarks/results/test262-report.json"
standalone_report="/workspace/benchmarks/results/test262-standalone-report.json"
# Fallback source for the "% sa" bar: the committed high-water mark carries
# official_pass/official_total (no-proposals) and IS refreshed on every push
# to main, whereas the full standalone report is not committed.
standalone_highwater="/workspace/benchmarks/results/test262-standalone-highwater.json"
compile_jsonl="/workspace/benchmarks/results/test262-compile.jsonl"
precompiling=$(ps aux 2>/dev/null | grep '[p]recompile-tests' | head -1)
vitesting=$(ps aux 2>/dev/null | grep -E '[v]itest.*test262|[r]un-test262-vitest' | head -1)

# bg_progress_bar pct label fill_bg empty_bg text_fg
# fill_bg/empty_bg/text_fg are ANSI color codes (e.g. 42, 100, 30)
bg_progress_bar() {
  awk -v pct="$1" -v label="$2" -v fill_bg="$3" -v empty_bg="$4" -v fg="$5" 'BEGIN {
    width = 12
    filled = int(pct * width / 100)
    bar = ""
    for (i = 0; i < width; i++) bar = bar " "
    bar = " " label substr(bar, length(label) + 2)
    filled_part = substr(bar, 1, filled)
    empty_part  = substr(bar, filled + 1)
    printf "\033[%s;%sm%s\033[48;5;237;37m%s\033[00m", fill_bg, fg, filled_part, empty_part
  }'
}

# Pass bar: green>=2/3, yellow>=1/3, red<1/3
pass_bar() {
  awk -v p="$1" -v label="$2" 'BEGIN {
    if (p >= 66.7)     { fill=42; fg=30 }
    else if (p >= 33.3){ fill=43; fg=30 }
    else               { fill="48;5;196"; fg=30 }
  }
  END {
    width = 12
    filled = int(p * width / 100)
    bar = ""
    for (i = 0; i < width; i++) bar = bar " "
    bar = " " label substr(bar, length(label) + 2)
    filled_part = substr(bar, 1, filled)
    empty_part  = substr(bar, filled + 1)
    printf "\033[%s;%sm%s\033[48;5;237;37m%s\033[00m", fill, fg, filled_part, empty_part
  }' /dev/null
}

# Free bar: green>=2/3 free, yellow>=1/3 free, red<1/3 free (out of 16G)
free_bar() {
  awk -v free_g="$1" 'BEGIN {
    total_g = 16
    pct = free_g * 100 / total_g
    if (pct >= 66.7)      { fill=42; fg=30 }
    else if (pct >= 33.3) { fill=43; fg=30 }
    else                  { fill="48;5;196"; fg=30 }
    width = 10
    filled = int(pct * width / 100)
    label = " " free_g "G free"
    bar = ""
    for (i = 0; i < width; i++) bar = bar " "
    bar = label substr(bar, length(label) + 1)
    filled_part = substr(bar, 1, filled)
    empty_part  = substr(bar, filled + 1)
    printf "\033[%s;%sm%s\033[48;5;237;37m%s\033[00m", fill, fg, filled_part, empty_part
  }'
}

# Agent summary (only on tech-lead/main — state counts from agent-status/*.json)
# Shows: Nactive Mci-wait, colored by freshness via last_seen heartbeat where available.
# Active count gets a per-model breakdown (e.g. "3▶(2×Fable 5 1×Sonnet 5)") when
# every active agent's status file carries a "model" field (self-reported by the
# agent per developer.md's write template — the parent statusline's own .model.id
# only reflects the ORCHESTRATOR session, not spawned subagents, so this is the
# only place per-subagent model is visible). Falls back to a flat count when any
# active file predates the model field or omits it.
if [ -z "$in_worktree" ] && [ "$branch" = "main" ] && [ -d "/workspace/.claude/agent-status" ]; then
  _now=$(date +%s)
  _n_active=0; _n_ciwait=0; _n_stale=0
  _active_models=""
  for _f in /workspace/.claude/agent-status/*.json; do
    [ -f "$_f" ] || continue
    [ "$(basename "$_f")" = "tech-lead.json" ] && continue
    _state=$(jq -r '.state // empty' "$_f" 2>/dev/null)
    [ -z "$_state" ] && continue
    # Freshness: prefer last_seen heartbeat; fall back to since if no heartbeat written yet
    _ls=$(jq -r '.last_seen // empty' "$_f" 2>/dev/null)
    if [ -z "$_ls" ]; then
      _ls=$(jq -r '.since // empty' "$_f" 2>/dev/null)
      case "$_ls" in *T*Z) _ls=$(date -d "$_ls" +%s 2>/dev/null || echo "") ;; esac
    fi
    _fresh=1
    if [ -n "$_ls" ]; then
      _age=$(( _now - _ls ))
      [ "$_age" -ge 600 ] && _fresh=0
    fi
    if [ "$_fresh" -eq 0 ]; then
      _n_stale=$(( _n_stale + 1 ))
    elif [ "$_state" = "active" ]; then
      _n_active=$(( _n_active + 1 ))
      _model=$(jq -r '.model // empty' "$_f" 2>/dev/null)
      [ -n "$_model" ] && _active_models="${_active_models}${_model}
"
    else
      _n_ciwait=$(( _n_ciwait + 1 ))
    fi
  done
  _total=$(( _n_active + _n_ciwait + _n_stale ))
  if [ "$_total" -gt 0 ]; then
    if [ "$_n_active" -gt 0 ]; then
      _model_lines=$(printf '%s' "$_active_models" | grep -c -v '^$')
      if [ "$_model_lines" -eq "$_n_active" ]; then
        _model_breakdown=$(printf '%s' "$_active_models" | grep -v '^$' | sort | uniq -c | \
          awk '{c=$1; $1=""; sub(/^[ \t]+/,""); printf "%s%s×%s", (NR>1?" ":""), c, $0}')
        printf ' \033[00;32m%d▶\033[00m(%s)' "$_n_active" "$_model_breakdown"
      else
        printf ' \033[00;32m%d▶\033[00m' "$_n_active"
      fi
    fi
    [ "$_n_ciwait" -gt 0 ] && printf ' \033[00;33m%d⏸\033[00m' "$_n_ciwait"
    [ "$_n_stale"  -gt 0 ] && printf ' \033[00;90m%d✕\033[00m'  "$_n_stale"
  fi
fi

# Sprint progress bar, idle indicator, days bar (only on tech-lead/main)
if [ -z "$in_worktree" ] && [ "$branch" = "main" ]; then
  sprint_n=""
  sprint_done=0
  sprint_total=0
  # statusline-sprint.mjs reads from origin/main via git grep (PRIMARY) so the
  # sprint numbers always reflect committed truth even when /workspace is stale.
  # Falls back to the local working-tree scan, then sprints.json, internally.
  sprint_mjs="/workspace/scripts/statusline-sprint.mjs"
  if [ -f "$sprint_mjs" ] && command -v node >/dev/null 2>&1; then
    sprint_data=$(node "$sprint_mjs" --porcelain 2>/dev/null)
    if [ -n "$sprint_data" ]; then
      sprint_n=$(echo "$sprint_data" | awk '{print $1}')
      sprint_done=$(echo "$sprint_data" | awk '{print $2}')
      sprint_total=$(echo "$sprint_data" | awk '{print $3}')
    fi
  fi
  if [ -z "$sprint_n" ]; then
    # Fallback only when node/the script is unavailable: read the (possibly
    # stale) pre-built cache directly (deduplicated, wont-fix counted as done).
    sprints_json="/workspace/website/dashboard/data/sprints.json"
    if [ -f "$sprints_json" ]; then
      # Prefer the live `current` window (#2751); else the latest active numbered
      # sprint. The label is "cur" for the current window, else its number.
      sprint_data=$(jq -r '
        ( ( [ .[] | select(.isCurrent == true) ] | first )
          // ( [ .[] | select(.sprintNumber != null and .isClosed == false and .isPlanning == false) ]
               | sort_by(.sprintNumber) | last ) ) as $s
        | if $s == null then empty
          else (if $s.isCurrent then "cur" else ($s.sprintNumber | tostring) end)
               + " " + ($s.completedIssueIds | length | tostring)
               + " " + ($s.issueIds | length | tostring)
          end
      ' "$sprints_json" 2>/dev/null)
      if [ -n "$sprint_data" ]; then
        sprint_n=$(echo "$sprint_data" | awk '{print $1}')
        sprint_done=$(echo "$sprint_data" | awk '{print $2}')
        sprint_total=$(echo "$sprint_data" | awk '{print $3}')
      fi
    fi
  fi
  if [ -n "$sprint_n" ] && [ "$sprint_total" -gt 0 ]; then
    sprint_pct=$((sprint_done * 100 / sprint_total))
    # Numbered sprint → "sN"; the live `current` window emits the non-numeric
    # token "cur" → render it as-is (no `s` prefix, and never coerce to s0).
    case "$sprint_n" in
      ''|*[!0-9]*) sprint_label="$sprint_n" ;;
      *)           sprint_label="s$sprint_n" ;;
    esac
    awk -v p="$sprint_pct" -v lbl="$sprint_label" -v done="$sprint_done" -v total="$sprint_total" 'BEGIN {
      if (p >= 67)      { fill=42;         fg=30 }
      else if (p >= 33) { fill=43;         fg=30 }
      else              { fill="48;5;196"; fg=30 }
      width = 12
      filled = int(p * width / 100)
      label = sprintf(" %d/%d %s", done, total, lbl)
      bar = ""
      for (i = 0; i < width; i++) bar = bar " "
      bar = label substr(bar, length(label) + 1)
      # Always show at least the label in fill color so bar is visible even at 0%
      if (filled < length(label)) filled = length(label)
      filled_part = substr(bar, 1, filled)
      empty_part  = substr(bar, filled + 1)
      printf " \033[%s;%sm%s\033[48;5;237;37m%s\033[00m", fill, fg, filled_part, empty_part
    }' /dev/null
  fi
fi
if [ -n "$precompiling" ]; then
  done_n=$(wc -l < "$compile_jsonl" 2>/dev/null || echo 0)
  printf ' \033[00;33m⟳compile:%s/48K\033[00m' "$done_n"
elif [ -n "$vitesting" ]; then
  jsonl=$(ls -t /workspace/benchmarks/results/test262-results-*.jsonl 2>/dev/null | head -1)
  [ -z "$jsonl" ] && jsonl="/workspace/benchmarks/results/test262-results.jsonl"
  if [ -f "$jsonl" ]; then
    # #106 — pass-rate numerator and denominator are scoped to the ~43k
    # ECMAScript current-standard tests (scope_official:true). The ~5k
    # TC39 proposal tests are excluded from the headline so the in-progress
    # statusline matches the landing-page default ("ECMAScript standard").
    # `total` (denominator of the progress bar) still counts every line
    # written so far; `expected` is the run's full size (~48k).
    pass_denom=$(grep -c '"scope_official":true' "$jsonl" 2>/dev/null || echo 0)
    if [ "$pass_denom" -gt 0 ]; then
      # JSONL carries scope tagging — count passes among official-scope tests only.
      pass=$(awk '/"scope_official":true/ && /"status":"pass"/ {n++} END{print n+0}' "$jsonl" 2>/dev/null || echo 0)
    else
      # Older runner without scope tagging — fall back to counting every pass.
      pass=$(grep -c '"status":"pass"' "$jsonl" 2>/dev/null || echo 0)
      pass_denom=$(wc -l < "$jsonl" 2>/dev/null || echo 0)
    fi
    total=$(wc -l < "$jsonl" 2>/dev/null || echo 0)
    if [ "$total" -gt 0 ]; then
      expected=$(jq -r '.full_summary.total // .summary.total // 48088' "$report" 2>/dev/null)
      pct=$((total * 100 / expected))
      if [ "$pass_denom" -gt 0 ]; then
        pass_pct=$(awk "BEGIN {printf \"%.1f\", $pass * 100 / $pass_denom}")
      else
        pass_pct="0.0"
      fi
      free_mb=$(free -m | awk '/Mem/{print $7}')
      free_g=$(awk "BEGIN {printf \"%.0f\", $free_mb / 1024}")
      # ETA from timestamp in filename
      eta_label="${pct}%"
      start_ts=$(echo "$jsonl" | grep -oE '[0-9]{8}-[0-9]{6}' | head -1)
      if [ -n "$start_ts" ]; then
        start_sec=$(echo "$start_ts" | awk -F'-' '{
          d=$1; t=$2
          fmt=d " " substr(t,1,2) ":" substr(t,3,2) ":" substr(t,5,2)
          cmd="date -d \""fmt"\" +%s"
          cmd | getline s; close(cmd); print s
        }' 2>/dev/null)
        now_sec=$(date +%s)
        elapsed=$((now_sec - start_sec))
        if [ "$elapsed" -gt 5 ] && [ "$total" -gt 0 ]; then
          remaining=$((expected - total))
          eta_sec=$((remaining * elapsed / total))
          if [ "$eta_sec" -lt 60 ]; then
            eta_label="${eta_sec}s left"
          else
            eta_label="$((eta_sec / 60))m left"
          fi
        fi
      fi
      d_bar=$(bg_progress_bar "$pct" "$eta_label" 42 100 30)
      if [ -z "$in_worktree" ]; then
        p_bar=$(pass_bar "$pass_pct" "${pass_pct}% t262")
        f_bar=$(free_bar "$free_g")
        printf ' \033[00;33m⟳t262\033[00m %s %s %s' "$p_bar" "$d_bar" "$f_bar"
      else
        printf ' \033[00;33m⟳t262\033[00m %s' "$d_bar"
      fi
    else
      printf ' \033[00;33m⟳t262:starting\033[00m'
    fi
  else
    printf ' \033[00;33m⟳t262:starting\033[00m'
  fi
elif [ -f "$report" ]; then
  # Read host pass/total from the base remote ref (test262-current.json is the
  # authoritative committed file, refreshed on every push to main). Fall back
  # to the local file only when the ref read fails (offline / first run).
  # No timeout: git show on a local ref is a pack-file read — never blocks.
  _t262_json=$(git -C "${cwd:-$(pwd)}" show "${_base_ref}:benchmarks/results/test262-current.json" 2>/dev/null)
  if [ -n "$_t262_json" ]; then
    pass=$(printf '%s' "$_t262_json" | jq -r '.summary.pass // .pass // 0' 2>/dev/null)
    total=$(printf '%s' "$_t262_json" | jq -r '.summary.total // .total // 1' 2>/dev/null)
  else
    # Fallback: local committed file (may be stale when /workspace is behind)
    _local_t262="/workspace/benchmarks/results/test262-current.json"
    [ ! -f "$_local_t262" ] && _local_t262="$report"
    pass=$(jq -r '.summary.pass // .pass // 0' "$_local_t262" 2>/dev/null)
    total=$(jq -r '.summary.total // .total // 1' "$_local_t262" 2>/dev/null)
  fi
  # A locally-run host report that is genuinely NEWER than the committed CI
  # baseline takes precedence — mirrors the standalone lane below. CI data
  # (test262-current.json, refreshed by promote-baseline on every push to main)
  # stays the default; a fresh local `pnpm run test:262` overrides it only while
  # it is actually newer. Both read .summary.* — the official standard+annexB
  # scope — so the denominator stays consistent with the CI numbers either way.
  _local_t262_ci="/workspace/benchmarks/results/test262-current.json"
  if [ -f "$report" ] && { [ ! -f "$_local_t262_ci" ] || [ "$report" -nt "$_local_t262_ci" ]; }; then
    _lp=$(jq -r '.summary.pass // empty' "$report" 2>/dev/null)
    _lt=$(jq -r '.summary.total // empty' "$report" 2>/dev/null)
    if [ -n "$_lp" ] && [ -n "$_lt" ] && [ "$_lt" -gt 0 ] 2>/dev/null; then
      pass="$_lp"
      total="$_lt"
    fi
  fi
  pass_pct=$(awk "BEGIN {printf \"%.1f\", $pass * 100 / $total}")
  free_mb=$(free -m | awk '/Mem/{print $7}')
  free_g=$(awk "BEGIN {printf \"%.0f\", $free_mb / 1024}")
  if [ -z "$in_worktree" ]; then
    p_bar=$(pass_bar "$pass_pct" "${pass_pct}% t262")
    f_bar=$(free_bar "$free_g")
    # Standalone (pure-Wasm, no JS host) test262 pass rate, shown right after
    # the JS-host bar. official_pass/official_total = standard+annexB (43,135),
    # TC39 proposals excluded, matching the host bar's denominator.
    sa_bar=""
    sa_pass=""; sa_total=""
    # Read standalone from the base remote ref (always current).
    # PREFERRED: a committed CURRENT standalone summary, mirroring the host
    # lane's test262-current.json. NOTE: as of 2026-07-24 CI does not yet write
    # this file — the landing page computes standalone live from
    # test262-standalone-current.jsonl in the baselines repo, which is why the
    # statusline and the landing page disagree. The moment promote-baseline
    # starts committing this summary, the statusline picks it up with no further
    # change. Until then we fall through to the high-water mark below, which is
    # a BEST-EVER figure, not a current rate.
    # Cheap stat guard FIRST: `git show` costs ~13s on this repo, so never pay
    # it for a path that does not exist yet. When CI starts committing the file
    # it will be present in the worktree after a pull, and only then do we read
    # the authoritative copy from the base ref.
    _sa_cur_json=""
    if [ -f "/workspace/benchmarks/results/test262-standalone-current.json" ]; then
      _sa_cur_json=$(git -C "${cwd:-$(pwd)}" show "${_base_ref}:benchmarks/results/test262-standalone-current.json" 2>/dev/null)
    fi
    if [ -n "$_sa_cur_json" ]; then
      sa_pass=$(printf '%s' "$_sa_cur_json" | jq -r '.official_summary.pass // .summary.pass // .official_pass // empty' 2>/dev/null)
      sa_total=$(printf '%s' "$_sa_cur_json" | jq -r '.official_summary.total // .summary.total // .official_total // empty' 2>/dev/null)
    fi
    _sa_json=""
    if [ -z "$sa_total" ]; then
      _sa_json=$(git -C "${cwd:-$(pwd)}" show "${_base_ref}:benchmarks/results/test262-standalone-highwater.json" 2>/dev/null)
    fi
    if [ -n "$_sa_json" ]; then
      sa_pass=$(printf '%s' "$_sa_json" | jq -r '.official_pass // empty' 2>/dev/null)
      sa_total=$(printf '%s' "$_sa_json" | jq -r '.official_total // empty' 2>/dev/null)
    elif [ -z "$sa_total" ]; then
      # Fallback to local high-water file
      if [ -f "$standalone_highwater" ]; then
        sa_pass=$(jq -r '.official_pass // empty' "$standalone_highwater" 2>/dev/null)
        sa_total=$(jq -r '.official_total // empty' "$standalone_highwater" 2>/dev/null)
      fi
    fi
    # A locally-run standalone report that is genuinely newer takes precedence.
    if [ -f "$standalone_report" ] && [ "$standalone_report" -nt "$standalone_highwater" ]; then
      sa_pass=$(jq -r '.summary.pass // 0' "$standalone_report" 2>/dev/null)
      sa_total=$(jq -r '.summary.total // 1' "$standalone_report" 2>/dev/null)
    fi
    if [ -n "$sa_total" ] && [ "$sa_total" -gt 0 ] 2>/dev/null; then
      sa_pct=$(awk "BEGIN {printf \"%.1f\", $sa_pass * 100 / $sa_total}")
      sa_bar=$(pass_bar "$sa_pct" "${sa_pct}% sa")
    fi
    if [ -n "$sa_bar" ]; then
      printf ' %s %s %s' "$p_bar" "$sa_bar" "$f_bar"
    else
      printf ' %s %s' "$p_bar" "$f_bar"
    fi
  fi
fi
# Branch display:
# - In worktree: prefer worktree.branch from JSON (authoritative), fall back to git
# - On main: show non-main git branches only
if [ -n "$in_worktree" ]; then
  show_branch="${worktree_branch:-$branch}"
  [ -n "$show_branch" ] && [ "$show_branch" != "main" ] && printf ' \033[00;37m%s\033[00m' "$show_branch"
else
  [ -n "$branch" ] && [ "$branch" != "main" ] && printf ' \033[00;37m%s\033[00m' "$branch"
fi
# Repo identity (owner/name) — shown only when available and not on main (already know the repo there)
[ -n "$repo" ] && [ -n "$in_worktree" ] && printf ' \033[00;90m%s\033[00m' "$repo"
[ -n "$effort" ] && [ "$effort" != "none" ] && [ "$effort" != "disabled" ] && printf ' \033[00;33m%s\033[00m' "$effort"
# Output style — shown when not "default" (non-default modes are worth flagging)
[ -n "$output_style" ] && [ "$output_style" != "default" ] && [ "$output_style" != "Default" ] && printf ' \033[00;36m[%s]\033[00m' "$output_style"
# Vim mode — shown when vim mode is active
[ -n "$vim_mode" ] && printf ' \033[00;35m%s\033[00m' "$vim_mode"
# Agent name — shown when running under --agent flag
[ -n "$agent_name" ] && printf ' \033[00;36magent:%s\033[00m' "$agent_name"
# Session name (when /rename has been used) — near the end of the line
[ -n "$session_name" ] && printf ' \033[00;36m(%s)\033[00m' "$session_name"
# PR badge from JSON (open PR for current branch) — kept last so it ends the line
if [ -n "$pr_number" ]; then
  case "$pr_state" in
    approved)           pr_color="00;32" ;  pr_icon="✓" ;;
    changes_requested)  pr_color="00;31" ;  pr_icon="✗" ;;
    draft)              pr_color="00;90" ;  pr_icon="~" ;;
    *)                  pr_color="00;33" ;  pr_icon="?" ;;
  esac
  printf ' \033[%smPR#%s%s\033[00m' "$pr_color" "$pr_number" "$pr_icon"
fi
printf '\n'
