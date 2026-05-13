#!/bin/bash
# Full test262 pipeline with logging
# Usage: ./scripts/run-test262.sh

set +e  # don't exit on vitest "failure" (test failures are exit code 1)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
RESULTS_DIR="$ROOT_DIR/benchmarks/results"
LOGFILE="$RESULTS_DIR/test262-run.log"

mkdir -p "$RESULTS_DIR"

log() { echo "$@" | tee -a "$LOGFILE"; }

echo "" > "$LOGFILE"
log "=== test262 run started at $(date) ==="
log "Git: $(git rev-parse --short HEAD)"

log ""
log "=== PRECOMPILE ==="
START=$(date +%s)
npx tsx scripts/precompile-tests.ts 2>&1 | tee -a "$LOGFILE"
END=$(date +%s)
log "Precompile took $((END - START))s"

log ""
# Truncate results JSONL before vitest (prevents duplicates from multi-fork writes)
> "$RESULTS_DIR/test262-results.jsonl"
log "=== VITEST ==="
START=$(date +%s)
VITEST_RUN_TIMEOUT_MS="${VITEST_RUN_TIMEOUT_MS:-90m}" node scripts/run-vitest.mjs run tests/test262-chunk*.test.ts >> "$LOGFILE" 2>&1
END=$(date +%s)
log "Vitest took $((END - START))s"

log ""
log "=== RESULTS ==="
python3 -c "
import json
d = json.load(open('$RESULTS_DIR/test262-report.json'))
s = d.get('official_summary', d['summary'])
full = d.get('full_summary', d['summary'])
print(f'Total: {s[\"total\"]}')
print(f'Pass:  {s[\"pass\"]}')
print(f'Fail:  {s[\"fail\"]}')
print(f'CE:    {s[\"compile_error\"]}')
print(f'Skip:  {s[\"skip\"]}')
print(f'Rate:  {s[\"pass\"]/s[\"total\"]*100:.1f}%')
if full['total'] != s['total']:
    print(f'Full suite total: {full[\"total\"]}')
" | tee -a "$LOGFILE"

log ""
log "=== Finished at $(date) ==="
