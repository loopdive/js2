#!/bin/bash
# Pre-agent-spawn hook: cap concurrency to the box's hardware, then log.
#
# Why this exists: agents are cheap when idle (waiting on the API) but each
# active one bursts a core during compile/test. With no CPU ceiling the box
# oversubscribes (load hit 13 on 8 cores), which starves sshd and drops
# interactive SSH sessions. We gate on the *load average* rather than a process
# count because the harness keeps a warm pool of `claude.exe` helpers
# (--bg-spare / --bg-pty-host) that makes process-counting a poor proxy for how
# many agents are actually working.
#
# Hardware-matched limits (tunable via env):
#   JS2WASM_MAX_LOAD    block new spawns when 1-min load >= this   (default: cores-2)
#   JS2WASM_MIN_RAM_MB  block new spawns when avail RAM < this MB   (default: 1500)
# The default leaves ~2 cores free for the lead, IDE, sshd and system so the box
# stays interactive. Raise JS2WASM_MAX_LOAD to trade responsiveness for throughput.

INPUT=$(cat)

CORES=$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)
# Default ceiling = cores-2 (leave headroom), floor of 1.
DEFAULT_MAX_LOAD=$(( CORES > 2 ? CORES - 2 : 1 ))
# Override precedence: env var > .claude/max-load file > cores-2 default.
# The file knob exists because the hook runs in its own process — an agent
# session cannot inject JS2WASM_MAX_LOAD into it mid-session. Per-box, gitignored.
FILE_MAX_LOAD=$(cat "${CLAUDE_PROJECT_DIR:-/workspace}/.claude/max-load" 2>/dev/null | tr -cd '0-9.')
MAX_LOAD=${JS2WASM_MAX_LOAD:-${FILE_MAX_LOAD:-$DEFAULT_MAX_LOAD}}
MIN_RAM_MB=${JS2WASM_MIN_RAM_MB:-1500}

# OS-aware RAM/load probes: Linux has free(1)+/proc; darwin needs vm_stat/sysctl.
if command -v free >/dev/null 2>&1; then
  AVAIL_MB=$(free -m | awk '/Mem/{print $7}')
else
  PAGESIZE=$(sysctl -n hw.pagesize 2>/dev/null || echo 4096)
  AVAIL_MB=$(vm_stat 2>/dev/null | awk -v ps="$PAGESIZE" '/Pages free|Pages inactive|Pages speculative/{gsub("\\.","",$NF); s+=$NF} END{printf "%d", s*ps/1048576}')
fi
if [ -r /proc/loadavg ]; then
  LOAD1=$(awk '{print $1}' /proc/loadavg 2>/dev/null)
else
  LOAD1=$(sysctl -n vm.loadavg 2>/dev/null | awk '{print $2}')
fi
# Coarse footprint for observability only (NOT used for the hard gate — see header).
CLAUDE_PROCS=$(pgrep -fc 'claude\.exe' 2>/dev/null || echo 0)

AGENT_NAME=$(echo "$INPUT" | jq -r '.tool_input.name // "unknown"' 2>/dev/null)
AGENT_TYPE=$(echo "$INPUT" | jq -r '.tool_input.subagent_type // "general"' 2>/dev/null)

EVENT_LOG="${CLAUDE_PROJECT_DIR:-/workspace}/.claude/hooks/event-log.sh"
if [ -f "$EVENT_LOG" ]; then source "$EVENT_LOG"; else log_event() { :; }; fi
log_event "agent_spawn" "agent=$AGENT_NAME" "type=$AGENT_TYPE" "ram_mb=$AVAIL_MB" "load1=$LOAD1" "cores=$CORES" "claude_procs=$CLAUDE_PROCS"

# Prefer teammates over bare subagents for sprint work — warn but don't block.
TEAM_NAME=$(echo "$INPUT" | jq -r '.tool_input.team_name // empty' 2>/dev/null)
if [ -z "$TEAM_NAME" ]; then
  log_event "agent_spawn_no_team" "agent=$AGENT_NAME" "reason=no_team_name"
  echo "NOTE: Agent spawned without team_name. For sprint dev agents use a team_name so they coordinate; bare subagents are fine for one-off research/fetches." >&2
fi

# --- Hardware-matched hard gates (exit 2 blocks the spawn) ---

# 1) RAM floor — don't spawn into a nearly-full box.
if [ "${AVAIL_MB:-0}" -lt "$MIN_RAM_MB" ]; then
  log_event "agent_spawn_blocked" "agent=$AGENT_NAME" "reason=low_ram" "ram_mb=$AVAIL_MB"
  echo "BLOCKED: only ${AVAIL_MB}MB RAM available (< ${MIN_RAM_MB}MB floor). Wait for an agent to finish before spawning more." >&2
  exit 2
fi

# 2) CPU load — don't pile onto an already-saturated box. This is the cap that
#    "matches the hardware": ~one core of active work per spawn, ~2 cores reserved.
if [ -n "$LOAD1" ] && awk -v l="$LOAD1" -v m="$MAX_LOAD" 'BEGIN{exit !(l+0 >= m+0)}'; then
  log_event "agent_spawn_blocked" "agent=$AGENT_NAME" "reason=high_load" "load1=$LOAD1" "max_load=$MAX_LOAD" "cores=$CORES"
  echo "BLOCKED: 1-min load ${LOAD1} >= ${MAX_LOAD} on a ${CORES}-core box — already at the hardware-matched concurrency cap. Let active agents drain before spawning more (or raise JS2WASM_MAX_LOAD to trade SSH responsiveness for throughput)." >&2
  exit 2
fi

exit 0
