#!/bin/bash
# Run test262 via vitest in an isolated git worktree.
# Usage: pnpm run test:262 [vitest args...]
#
# - Uses flock to prevent parallel runs (only one test262 at a time)
# - Writes results to timestamped files, updates symlink only on completion
# - Builds compiler bundle from the worktree (not /workspace)
# - Includes proposal tests by default; pass --official-scope-only to exclude them

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MAIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOCKFILE="/tmp/js2wasm-test262.lock"
LOCKDIR="/tmp/js2wasm-test262.lockdir"
RESULTS_DIR="$MAIN_DIR/benchmarks/results"
RUN_TIMESTAMP=$(date +%Y%m%d-%H%M%S)
INCLUDE_PROPOSALS=1
TEST262_TARGET="${TEST262_TARGET:-gc}"
TEST262_REPORTER="${TEST262_REPORTER:-verbose}"
EVAL_ENGINE="${JS2WASM_EVAL_ENGINE:-quickjs}"

case "$TEST262_TARGET" in
  gc|linear|wasi|standalone) ;;
  *)
    echo "ERROR: TEST262_TARGET must be one of: gc, linear, wasi, standalone"
    exit 1
    ;;
esac

if [ "$TEST262_TARGET" = "standalone" ]; then
  case "$EVAL_ENGINE" in
    interpreter|quickjs) ;;
    *)
      echo "ERROR: JS2WASM_EVAL_ENGINE must be one of: interpreter, quickjs"
      exit 1
      ;;
  esac
fi

RESULT_PREFIX="test262"
if [ "$TEST262_TARGET" != "gc" ]; then
  RESULT_PREFIX="test262-${TEST262_TARGET}"
fi

forwarded_args=()
for arg in "$@"; do
  if [ "$arg" = "--include-proposals" ]; then
    INCLUDE_PROPOSALS=1
  elif [ "$arg" = "--official-scope-only" ]; then
    INCLUDE_PROPOSALS=0
  else
    forwarded_args+=("$arg")
  fi
done
export TEST262_INCLUDE_PROPOSALS="$INCLUDE_PROPOSALS"
export TEST262_TARGET
export TEST262_RESULT_PREFIX="$RESULT_PREFIX"

resolve_esbuild() {
  if [ -n "${ESBUILD_BIN:-}" ] && [ -x "${ESBUILD_BIN:-}" ]; then
    echo "$ESBUILD_BIN"
    return 0
  fi
  if command -v esbuild >/dev/null 2>&1; then
    command -v esbuild
    return 0
  fi
  if [ -x "$MAIN_DIR/node_modules/.bin/esbuild" ]; then
    echo "$MAIN_DIR/node_modules/.bin/esbuild"
    return 0
  fi
  local candidate
  candidate=$(find "$MAIN_DIR/node_modules/.pnpm" -path '*/node_modules/esbuild/bin/esbuild' -type f 2>/dev/null | head -n 1)
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then
    echo "$candidate"
    return 0
  fi
  return 1
}

cleanup_lock() {
  if [ -d "$LOCKDIR" ]; then
    rm -rf "$LOCKDIR"
  fi
}

cleanup_worktree() {
  if [ "${USE_WORKTREE:-0}" != "1" ]; then
    return
  fi
  echo "Cleaning up worktree..."
  cd "$MAIN_DIR"
  git worktree remove --force "$WT_DIR" 2>/dev/null || rm -rf "$WT_DIR"
}

cleanup() {
  if [ -n "${MONITOR_PID:-}" ]; then
    kill "$MONITOR_PID" 2>/dev/null || true
    wait "$MONITOR_PID" 2>/dev/null || true
  fi
  if [ -n "${WT_DIR:-}" ] && [ -e "${WT_DIR:-}" ]; then
    cleanup_worktree
  fi
  cleanup_lock
}

trap cleanup EXIT

# ── Exclusive lock — only one test262 run at a time ──────────────
if command -v flock >/dev/null 2>&1; then
  exec 200>"$LOCKFILE"
  if ! flock -n 200; then
    echo "ERROR: Another test262 run is in progress (lock held: $LOCKFILE)"
    echo "Wait for it to finish or kill the process holding the lock."
    exit 1
  fi
else
  if mkdir "$LOCKDIR" 2>/dev/null; then
    echo "$$" > "$LOCKFILE"
  else
    LOCK_PID=""
    if [ -f "$LOCKFILE" ]; then
      LOCK_PID="$(cat "$LOCKFILE" 2>/dev/null || true)"
    fi
    if [ -n "$LOCK_PID" ] && kill -0 "$LOCK_PID" 2>/dev/null; then
      echo "ERROR: Another test262 run is in progress (pid $LOCK_PID)"
      echo "Wait for it to finish or remove the stale lock: $LOCKDIR"
      exit 1
    fi
    rm -rf "$LOCKDIR"
    rm -f "$LOCKFILE"
    mkdir "$LOCKDIR"
    echo "$$" > "$LOCKFILE"
  fi
fi
echo "Lock acquired (PID $$)"

# ── Create isolated worktree ─────────────────────────────────────
WT_DIR="/tmp/js2wasm-vitest-$$"
USE_WORKTREE=1

# Local dev runs should exercise the current workspace, not a clean detached
# worktree at HEAD. Otherwise uncommitted compiler changes are silently ignored.
if [ -n "$(git -C "$MAIN_DIR" status --porcelain --untracked-files=normal)" ]; then
  echo "Working tree has local changes; running test262 from current workspace"
  WT_DIR="$MAIN_DIR"
  USE_WORKTREE=0
else
  echo "Creating worktree at $WT_DIR ..."
  if ! git -C "$MAIN_DIR" worktree add "$WT_DIR" HEAD --detach --quiet 2>/dev/null; then
    echo "Worktree creation failed; falling back to current workspace"
    WT_DIR="$MAIN_DIR"
    USE_WORKTREE=0
  fi
fi

# Symlink heavy directories to avoid duplication
if [ "$USE_WORKTREE" = "1" ]; then
  bash "$MAIN_DIR/scripts/provision-worktree-deps.sh" "$WT_DIR"
fi

# Verify symlinks
if [ ! -d "$WT_DIR/test262/test" ]; then
  echo "ERROR: test262 symlink failed"
  exit 1
fi
echo "test262 symlink OK ($(ls "$WT_DIR/test262/test/" | wc -l) dirs)"

# Share the disk cache
mkdir -p "$MAIN_DIR/.test262-cache"
if [ "$USE_WORKTREE" = "1" ]; then
  ln -sf "$MAIN_DIR/.test262-cache" "$WT_DIR/.test262-cache"
fi

# ── Build compiler bundle FROM THE WORKTREE (not /workspace) ─────
echo "Building compiler bundle in worktree..."
cd "$WT_DIR"
ESBUILD_BIN="$(resolve_esbuild || true)"
if [ -z "$ESBUILD_BIN" ]; then
  echo "ERROR: esbuild not found (checked PATH, node_modules/.bin, pnpm store)"
  exit 1
fi
"$ESBUILD_BIN" src/index.ts --bundle --platform=node --format=esm \
  --outfile=scripts/compiler-bundle.mjs --external:typescript --external:binaryen 2>&1 | tail -1
"$ESBUILD_BIN" src/runtime.ts --bundle --platform=node --format=esm \
  --outfile=scripts/runtime-bundle.mjs --external:typescript --external:binaryen 2>&1 | tail -1

# ── Prebuild the standalone runtime-eval provider (#2928 E6/E7) ──
# Standalone modules that use dynamic eval / new Function link a core-Wasm
# `js2wasm:runtime-eval` provider. Build it ONCE here — the pool workers only
# load the cached binary (the per-test pool timeout is 30s). Idempotent: a
# cache hit exits in <1s, and the cache lives in the shared .test262-cache.
#
# TWO engines (#4242): QuickJS is the default behind the frozen
# `js2wasm:runtime-eval` seam. The native Acorn+bytecode interpreter remains a
# permanent opt-in via JS2WASM_EVAL_ENGINE=interpreter. Its refusal/full tiers
# are still selected by TEST262_FULL_RUNTIME_EVAL exactly as before.
#
# Prebuild the selected engine here (the selector never builds), and fail the
# run on error rather than degrading to the other engine. Silent fallback would
# label one engine's conformance numbers as the other's.
#
# Build ONLY the selected engine. Building the interpreter fallback after a
# quickjs prebuild makes a missing/mis-keyed quickjs cache harder to diagnose
# and wastes minutes, while the selector is deliberately forbidden from
# falling back between engines.
if [ "$TEST262_TARGET" = "standalone" ]; then
  echo "Eval engine selection: $EVAL_ENGINE"
  case "$EVAL_ENGINE" in
    quickjs)
      echo "Prebuilding QUICKJS eval-engine provider (#4242 default)..."
      NODE_OPTIONS="--max-old-space-size=3072" node scripts/build-quickjs-eval-provider.mjs
      ;;
    interpreter)
      if [ "${TEST262_FULL_RUNTIME_EVAL:-}" = "1" ]; then
        echo "Prebuilding runtime-eval provider — refusal + FULL interpreter (#2928 E7)..."
        NODE_OPTIONS="--max-old-space-size=3072" node scripts/build-runtime-eval-provider.mjs
      else
        echo "Prebuilding runtime-eval REFUSAL provider (#2928 E7; TEST262_FULL_RUNTIME_EVAL=1 for the interpreter)..."
        NODE_OPTIONS="--max-old-space-size=3072" node scripts/build-runtime-eval-provider.mjs --refusal-only
      fi
      ;;
  esac
fi

# ── Prepare result files ─────────────────────────────────────────
# Vitest writes to timestamped ${RESULT_PREFIX}-results-YYYYMMDD-HHMMSS.jsonl directly.
# RUN_TIMESTAMP env var tells test262-shared.ts which filename to use.
export RUN_TIMESTAMP

# Symlink worktree results dir to main workspace (results survive cleanup)
if [ "$USE_WORKTREE" = "1" ]; then
  rm -rf "$WT_DIR/benchmarks/results"
  ln -s "$RESULTS_DIR" "$WT_DIR/benchmarks/results"
fi

echo "Run ID: $RUN_TIMESTAMP"
echo "Target: $TEST262_TARGET"
echo "Reporter: $TEST262_REPORTER"
echo "Worktree at $(git -C "$WT_DIR" rev-parse --short HEAD)"
echo "Running vitest (unified compile+execute in fork pool)..."

# ── Start memory monitor ─────────────────────────────────────────
MONITOR_LOG="$RESULTS_DIR/memory-monitor-${RUN_TIMESTAMP}.jsonl"
MONITOR_PID=""
if command -v free >/dev/null 2>&1 && [ -d /proc ]; then
  (
    echo "{\"event\":\"monitor_start\",\"timestamp\":\"$(date -Iseconds)\",\"available_mb\":$(free -m | awk '/Mem/{print $7}')}" >> "$MONITOR_LOG"
    while true; do
      if ! ps aux | grep -q '[v]itest'; then
        echo "{\"event\":\"monitor_end\",\"timestamp\":\"$(date -Iseconds)\",\"available_mb\":$(free -m | awk '/Mem/{print $7}')}" >> "$MONITOR_LOG"
        break
      fi
      AVAIL=$(free -m | awk '/Mem/{print $7}')
      USED=$(free -m | awk '/Mem/{print $3}')
      PROCS=""
      FIRST=true
      for pid in $(ps aux | grep '[v]itest' | awk '{print $2}'); do
        PEAK=$(grep VmHWM /proc/$pid/status 2>/dev/null | awk '{print $2}')
        RSS=$(grep VmRSS /proc/$pid/status 2>/dev/null | awk '{print $2}')
        NAME=$(ps -p $pid -o comm= 2>/dev/null)
        if [ -n "$PEAK" ] && [ "$PEAK" -gt 10000 ]; then
          if [ "$FIRST" = true ]; then FIRST=false; else PROCS="$PROCS,"; fi
          PROCS="$PROCS{\"pid\":$pid,\"name\":\"$NAME\",\"rss_mb\":$((RSS/1024)),\"peak_mb\":$((PEAK/1024))}"
        fi
      done
      echo "{\"timestamp\":\"$(date -Iseconds)\",\"available_mb\":$AVAIL,\"used_mb\":$USED,\"vitest\":[$PROCS]}" >> "$MONITOR_LOG"
      sleep 10
    done
  ) &
  MONITOR_PID=$!
  echo "Memory monitor started (PID $MONITOR_PID, log: $MONITOR_LOG)"
else
  echo "Memory monitor skipped: unsupported platform"
fi

# ── Run vitest chunk-by-chunk FROM THE WORKTREE ─────────────────
# Local runs use 16 weighted shards (tests/test262-local-shard{1..16}.test.ts).
# CI uses the 57-chunk matrix (tests/test262-chunk{1..57}.test.ts) — needs many
# parallel runners. Locally vitest.config.ts has maxForks=1, so wall time scales
# linearly with shard count → fewer/larger shards = faster local runs.
# Override pattern via TEST262_LOCAL_SHARD_GLOB env to scope a quick subset.
cd "$WT_DIR"
LOCAL_SHARD_GLOB="${TEST262_LOCAL_SHARD_GLOB:-tests/test262-local-shard*.test.ts}"
CHUNKS=$(ls $LOCAL_SHARD_GLOB 2>/dev/null | sort)
> /tmp/test262-vitest-run.log

# Vitest loses TTY detection when piped through tee. Force ANSI colors so
# failures stay readable in the terminal while still being captured to disk.
unset NO_COLOR
export FORCE_COLOR=1
export CLICOLOR_FORCE=1

if [ -n "$CHUNKS" ]; then
  # Run all shard files in a single vitest invocation — vitest parallelizes across forks
  CHUNK_COUNT=$(echo "$CHUNKS" | wc -l)
  echo "Running $CHUNK_COUNT local shard files in one vitest invocation..."
  if [ ${#forwarded_args[@]} -gt 0 ]; then
    node node_modules/vitest/dist/cli.js run $LOCAL_SHARD_GLOB \
      --reporter="$TEST262_REPORTER" \
      "${forwarded_args[@]}" 2>&1 | tee /tmp/test262-vitest-run.log || true
  else
    node node_modules/vitest/dist/cli.js run $LOCAL_SHARD_GLOB \
      --reporter="$TEST262_REPORTER" 2>&1 | tee /tmp/test262-vitest-run.log || true
  fi
else
  # Single file mode: run the monolithic test file
  echo "Running single test file..."
  if [ ${#forwarded_args[@]} -gt 0 ]; then
    node node_modules/vitest/dist/cli.js run tests/test262-vitest.test.ts \
      --reporter="$TEST262_REPORTER" \
      "${forwarded_args[@]}" 2>&1 | tee /tmp/test262-vitest-run.log || true
  else
    node node_modules/vitest/dist/cli.js run tests/test262-vitest.test.ts \
      --reporter="$TEST262_REPORTER" 2>&1 | tee /tmp/test262-vitest-run.log || true
  fi
fi
# Generate report.json from JSONL (atomic — no fork race condition)
JSONL_FILE="$RESULTS_DIR/${RESULT_PREFIX}-results-${RUN_TIMESTAMP}.jsonl"
REPORT_FILE="$RESULTS_DIR/${RESULT_PREFIX}-report-${RUN_TIMESTAMP}.json"
COMPLETED=false
if [ -f "$JSONL_FILE" ] && [ -s "$JSONL_FILE" ]; then
  report_args=(
    scripts/build-test262-report.mjs
    --input "$JSONL_FILE"
    --output "$REPORT_FILE"
    --target "$TEST262_TARGET"
    --baseline-generated-at "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  )
  if [ "$INCLUDE_PROPOSALS" = "1" ]; then
    report_args+=(--include-proposals)
  fi
  if [ "$TEST262_TARGET" = "standalone" ]; then
    report_args+=(--max-unclassified-root-causes "${TEST262_MAX_UNCLASSIFIED_ROOT_CAUSES:-0}")
  fi
  if node "${report_args[@]}"; then
    PASS_SUMMARY=$(node -e "const d=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')); const s=d.summary; console.log('Report: '+s.pass+' pass / '+s.total+' total ('+(s.total ? (s.pass/s.total*100).toFixed(1) : '0.0')+'%)')" "$REPORT_FILE")
    echo "$PASS_SUMMARY"
    COMPLETED=true
  else
    report_status=$?
    echo "Report generation failed with exit status $report_status"
    exit "$report_status"
  fi
fi

# ── Stop memory monitor ──────────────────────────────────────────
if [ -n "$MONITOR_PID" ]; then
  kill "$MONITOR_PID" 2>/dev/null || true
  wait "$MONITOR_PID" 2>/dev/null || true
  echo "Memory monitor stopped"
fi

# ── Summarize peak memory ────────────────────────────────────────
if [ -f "$MONITOR_LOG" ]; then
  PEAK_RSS=$(python3 -c "
import json
peak = 0
with open('$MONITOR_LOG') as f:
    for line in f:
        d = json.loads(line)
        for v in d.get('vitest', []):
            if v.get('peak_mb', 0) > peak: peak = v['peak_mb']
print(peak)
" 2>/dev/null || echo "?")
  echo "Peak vitest memory: ${PEAK_RSS}MB"
fi

# ── Handle results ───────────────────────────────────────────────
echo ""

# Files are already timestamped (vitest writes to ${RESULT_PREFIX}-results-${RUN_TIMESTAMP}.jsonl)
RUN_REPORT="$RESULTS_DIR/${RESULT_PREFIX}-report-${RUN_TIMESTAMP}.json"
RUN_JSONL="$RESULTS_DIR/${RESULT_PREFIX}-results-${RUN_TIMESTAMP}.jsonl"

if [ "$COMPLETED" = true ]; then
  # Update symlinks to point to latest timestamped files
  ln -sf "$(basename "$RUN_REPORT")" "$RESULTS_DIR/${RESULT_PREFIX}-report.json"
  ln -sf "$(basename "$RUN_JSONL")" "$RESULTS_DIR/${RESULT_PREFIX}-results.jsonl"

  PASS=$(python3 -c "import json; d=json.load(open('$RUN_REPORT')); print(d['summary']['pass'])" 2>/dev/null || echo "?")
  TOTAL=$(python3 -c "import json; d=json.load(open('$RUN_REPORT')); print(d['summary']['total'])" 2>/dev/null || echo "?")
  echo "COMPLETED: $PASS pass / $TOTAL total"
  echo "Report:  $RUN_REPORT"
  echo "Results: $RUN_JSONL"
  echo "Symlinks updated."

  # Append to historical index.
  #
  # (#4412) ONLY for a full-corpus run. `runs/index.json` is COMMITTED and
  # feeds the report page's conformance trend graph, but this append had no
  # notion of a scoped run: with `TEST262_PATH_FILTER` or a narrowed
  # `TEST262_LOCAL_SHARD_GLOB`, a partial run posted a partial total as if it
  # were a full pass. Measured 2026-08-14: a single-shard local run wrote
  # `pass: 1902 / total: 2713` beside real ~30,000-test entries, and a
  # 32-invocation sharded experiment would have written 32 such rows. Nothing
  # in CI would have caught it — it surfaced only because a local stop hook
  # noticed the dirty file.
  #
  # Default is to REFUSE when the run is scoped. `TEST262_PUBLISH_HISTORY=1`
  # forces the append for the rare case where a deliberately scoped run should
  # still be recorded; `TEST262_PUBLISH_HISTORY=0` suppresses it outright.
  # The decision lives in scripts/should-publish-run-history.mjs so it can be
  # unit-tested; exit 0 = publish, 1 = skip, reason on stdout.
  if PUBLISH_REASON=$(TEST262_LOCAL_SHARD_GLOB="$LOCAL_SHARD_GLOB" \
      node "$MAIN_DIR/scripts/should-publish-run-history.mjs"); then
    PUBLISH_HISTORY=1
  else
    PUBLISH_HISTORY=0
  fi

  if [ "$PUBLISH_HISTORY" != "1" ]; then
    echo "Historical index: SKIPPED — $PUBLISH_REASON."
    echo "  runs/index.json is committed and drives the trend graph; a partial"
    echo "  run must not post a partial total. Override with TEST262_PUBLISH_HISTORY=1."
  elif [ -f "$RUN_REPORT" ]; then
    RUNS_DIR="$RESULTS_DIR/runs"
    mkdir -p "$RUNS_DIR"
    INDEX_FILE="$RUNS_DIR/index.json"
    if [ ! -f "$INDEX_FILE" ]; then echo '[]' > "$INDEX_FILE"; fi
    python3 -c "
import json, sys
with open('$RUN_REPORT') as f: report = json.load(f)
entry = {
    'timestamp': '$RUN_TIMESTAMP',
    'pass': report['summary']['pass'],
    'fail': report['summary']['fail'],
    'ce': report['summary'].get('compile_error', 0),
    'skip': report['summary'].get('skip', 0),
    'total': report['summary']['total'],
    'strict_pass': report.get('strict_summary', {}).get('pass', 0),
    'strict_total': report.get('strict_summary', {}).get('total', 0),
}
with open('$INDEX_FILE') as f: idx = json.load(f)
idx.append(entry)
with open('$INDEX_FILE', 'w') as f: json.dump(idx, f, indent=2)
print('Appended to index: %d pass / %d total' % (entry['pass'], entry['total']))
" 2>/dev/null || echo "Warning: failed to update historical index"
  fi
else
  echo "INCOMPLETE: Report generation failed or no results."
  echo "Check /tmp/test262-vitest-run.log for errors."
fi

# ── Cleanup ──────────────────────────────────────────────────────
echo "Done."
