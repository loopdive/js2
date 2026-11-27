#!/usr/bin/env bash
# #7537 — the verdict of an edition-scope measurement, shared by the IR queue
# gate and the legacy lane's completed-edition check:
#   1. report the run against its baseline;
#   2. re-check, once, the rows the report would act on (every regression still
#      in the run, and every watched compile_timeout that repeated, under a
#      raised compile timeout), overriding their rows in <results.jsonl>;
#   3. report again on the overridden rows. That report is the verdict.
# A regression that passes on re-check was a flake of the shard run and never
# reaches a gate.
#
#   scripts/test262-edition-verdict.sh <results.jsonl> <scope.json> <editions> <baseline-dir> <prs.json> <out-dir>
#
# Writes <out-dir>/edition-report.{json,md} and <out-dir>/timeout-watch.json.
# Exit: the final report's (0 ok · 3 regression · other = crash). The caller's
# environment must be the shard's (target, oracle mode, eval engine,
# proposals): only the pool size, the path list and, for watched rows, the
# compile timeout differ in the re-check.
set -euo pipefail

results=$1 meta=$2 editions=$3 baseline=$4 prs=$5 out=$6
mkdir -p "$out"
scope_ts=scripts/test262-edition-scope.ts

report() {
  node --experimental-strip-types "$scope_ts" report --results "$results" --meta "$meta" --test262 test262 \
    --editions "$editions" --baseline-dir "$baseline" --prs "$prs" --watch-out "$out/timeout-watch.json" \
    --summary "$out/edition-report.md" --json "$out/edition-report.json"
}

code=0
report >/dev/null || code=$?
if [ "$code" != 0 ] && [ "$code" != 3 ]; then exit "$code"; fi

node --experimental-strip-types "$scope_ts" candidates --report "$out/edition-report.json" \
  --watched "$out/recheck-watched.txt" --other "$out/recheck-other.txt"

rechecks=()
recheck() { # <path-list> <label> <override-flag> [compile-timeout-ms]
  [ -s "$1" ] || return 0
  local prefix="test262-recheck-$2" status=0
  # The runner appends to its results file; start from an empty one.
  rm -f "benchmarks/results/$prefix-results-$2.jsonl"
  env TEST262_PATH_FILTER_FILE="$1" TEST262_PATH_FILTER="" TEST262_CHUNK_INDEX=0 TEST262_CHUNK_TOTAL=1 \
    COMPILER_POOL_SIZE=1 TEST262_RESULT_PREFIX="$prefix" RUN_TIMESTAMP="$2" \
    ${4:+TEST262_COMPILE_TIMEOUT_MS=$4} \
    node node_modules/vitest/dist/cli.js run tests/test262-chunk-dynamic.test.ts --reporter=dot || status=$?
  # Vitest exits 1 when a test262 row fails; anything else is a crash.
  if [ "$status" -gt 1 ]; then
    echo "::error::the re-check crashed (vitest exit $status)"
    exit "$status"
  fi
  rechecks+=("$3" "benchmarks/results/$prefix-results-$2.jsonl")
}
recheck "$out/recheck-watched.txt" watched --recheck-watched "$(node --input-type=module -e \
  "import { RECHECK_COMPILE_TIMEOUT_MS as ms } from './scripts/lib/test262-timeout-watch.mjs'; console.log(ms)")"
recheck "$out/recheck-other.txt" other --recheck

if [ ${#rechecks[@]} -gt 0 ]; then
  node --experimental-strip-types "$scope_ts" override --results "$results" "${rechecks[@]}"
fi
report
