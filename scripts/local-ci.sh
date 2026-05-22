#!/usr/bin/env bash
# Local CI driver for Claude Code on Web (or any 16GB+ container).
#
# Enabled when JS2WASM_LOCAL_CI=1. Ensures the container has node_modules
# and the test262 submodule, then runs the full test262 suite at
# COMPILER_POOL_SIZE=4 (one worker per core on this 4-core container).
#
# Baseline (2026-05-20, 4 cores / 16GB RAM / 0 swap):
#   wall-clock ~68 min, peak RAM ~2.8 GB (massive headroom)
#
# Usage:
#   JS2WASM_LOCAL_CI=1 ./scripts/local-ci.sh           # setup + test262
#   JS2WASM_LOCAL_CI=1 ./scripts/local-ci.sh --setup   # setup only
#   JS2WASM_LOCAL_CI=1 ./scripts/local-ci.sh --run     # skip setup, just run
#
# Tunables:
#   COMPILER_POOL_SIZE=4   override worker count (default: nproc)
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

run() {
  local workers="${COMPILER_POOL_SIZE:-$(nproc)}"
  echo "==> Local CI test262 run (COMPILER_POOL_SIZE=$workers)"
  COMPILER_POOL_SIZE="$workers" pnpm run test:262
}

case "$MODE" in
  setup) setup ;;
  run)   run ;;
  all)   setup; run ;;
esac
