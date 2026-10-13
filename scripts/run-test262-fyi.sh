#!/bin/bash
# Gate route selection before the package entrypoint builds compiler bundles.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPILER_PATH="${TEST262_COMPILER_PATH:-legacy}"
TARGET="gc"
next=""
for arg in "$@"; do
  if [ "$next" = "path" ]; then COMPILER_PATH="$arg"; next=""; continue; fi
  if [ "$next" = "target" ]; then TARGET="$arg"; next=""; continue; fi
  case "$arg" in
    --compiler-path) next="path" ;;
    --compiler-path=*) COMPILER_PATH="${arg#--compiler-path=}" ;;
    --target) next="target" ;;
  esac
done
if [ -n "$next" ]; then echo "Missing value for $next" >&2; exit 2; fi
case "$TARGET" in
  gc|standalone|wasi) ;;
  *) echo "Target must be gc, standalone or wasi" >&2; exit 2 ;;
esac
case "$COMPILER_PATH" in
  legacy) ;;
  ir)
    prefix="test262"
    if [ "$TARGET" != "gc" ]; then prefix="test262-$TARGET"; fi
    if [ "${TEST262_SEMANTIC_PROVIDERS:-auto}" != "auto" ]; then
      prefix="${prefix}-${TEST262_SEMANTIC_PROVIDERS}"
    fi
    node "$SCRIPT_DIR/check-test262-compiler-path.mjs" --compiler-path ir \
      --status "$ROOT/benchmarks/results/${prefix}-ir-status.json"
    exit 2
    ;;
  *) echo "Compiler path must be legacy or ir" >&2; exit 2 ;;
esac
export TEST262_COMPILER_PATH="$COMPILER_PATH"
cd "$ROOT"
if [ "${TEST262_FYI_SMOKE:-}" != "1" ]; then node scripts/test262-fyi-runtime.mjs; fi
pnpm run build:compiler-bundle
if [ "${TEST262_FYI_SMOKE:-}" = "1" ]; then
  exec node scripts/run-test262-fyi.mjs --non-authoritative-smoke "$@"
fi
exec node scripts/run-test262-fyi.mjs "$@"
