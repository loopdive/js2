#!/usr/bin/env bash
# Local CI driver for Claude Code on Web (or any 16GB+ container).
#
# Enabled when JS2WASM_LOCAL_CI=1. Ensures the container has node_modules
# and the test262 submodule, then runs the full test262 suite at
# COMPILER_POOL_SIZE=$(nproc)-1 — one worker per core, less one left for the
# shell, the editor and sshd. Do NOT hardcode a core count here: this script
# runs on containers from 4 cores upward, and the previous `$(nproc)` default
# took *every* core, which starves interactive use on the bigger boxes.
# The floor is 1, so a single-core container still runs.
#
# This matches `tests/test262-shared.ts`, whose POOL_SIZE default is already
# `availableParallelism() - 1`; the env var set here just makes the choice
# explicit and visible in the run banner.
#
# Baseline (2026-05-20, 4 cores / 16GB RAM / 0 swap, then at pool 4):
#   wall-clock ~68 min, peak RAM ~2.8 GB (massive headroom)
#
# Usage:
#   JS2WASM_LOCAL_CI=1 ./scripts/local-ci.sh           # setup + test262
#   JS2WASM_LOCAL_CI=1 ./scripts/local-ci.sh --setup   # setup only
#   JS2WASM_LOCAL_CI=1 ./scripts/local-ci.sh --run     # skip setup, just run
#
# Tunables:
#   COMPILER_POOL_SIZE=N   override worker count (default: nproc - 1, min 1)
#   TEST262_SHALLOW=1      shallow-clone the test262 submodule (default)

set -euo pipefail

if [ "${JS2WASM_LOCAL_CI:-0}" != "1" ]; then
  echo "JS2WASM_LOCAL_CI is not set to 1 — skipping local CI."
  echo "To enable, run: JS2WASM_LOCAL_CI=1 $0 $*"
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_DIR"

MODE="all"
for arg in "$@"; do
  case "$arg" in
    --setup) MODE="setup" ;;
    --run)   MODE="run" ;;
    *) echo "Unknown arg: $arg" >&2; exit 2 ;;
  esac
done

setup() {
  echo "==> Local CI setup"
  echo "    cores:  $(nproc)"
  echo "    memory: $(free -m | awk '/Mem/{print $2}') MB total"

  if [ ! -d node_modules/vitest ]; then
    echo "==> pnpm install"
    pnpm install --prefer-offline
  else
    echo "==> node_modules present, skipping pnpm install"
  fi

  if [ ! -d test262/test ]; then
    echo "==> git submodule update --init (shallow) test262"
    if [ "${TEST262_SHALLOW:-1}" = "1" ]; then
      git submodule update --init --depth 1 test262
    else
      git submodule update --init test262
    fi
  else
    echo "==> test262 submodule present, skipping clone"
  fi
}

# Default parallelism: one worker per core, less one for the shell/editor/sshd.
# Derived from nproc at run time — never a hardcoded core count.
default_workers() {
  local cores
  cores="$(nproc 2>/dev/null || echo 1)"
  if [ "$cores" -gt 1 ]; then echo "$((cores - 1))"; else echo 1; fi
}

run() {
  local workers="${COMPILER_POOL_SIZE:-$(default_workers)}"
  echo "==> Local CI test262 run (COMPILER_POOL_SIZE=$workers)"
  COMPILER_POOL_SIZE="$workers" pnpm run test:262
}

case "$MODE" in
  setup) setup ;;
  run)   run ;;
  all)   setup; run ;;
esac
