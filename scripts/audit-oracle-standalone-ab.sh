#!/bin/bash
# Standalone test262 A/B — checker vs inhouse oracle backend (#4218/#4410).
#
# RESUMABLE BY SHARD. Three previous attempts at a single long run all died:
# nohup, setsid and a plain background task were all reaped or lost to a
# container restart before finishing. Ephemeral containers do not host a
# multi-hour process, so do not try. Instead
# each of the 16 shards runs as its own invocation and checkpoints to
# shards/<backend>-shard<N>.jsonl; a restart costs one shard, and re-running
# this script skips everything already on disk.
#
# Per-shard overhead is a worktree + bundle rebuild (~20s); 32 invocations pay
# ~11 min for that, which is cheap against losing a long pass.
#
# SCOPED to the risk areas, because a full pass is not affordable here. Shard 1
# alone took 31 min for 3,045 tests (~98 tests/min on 4 cores), so all 53,575
# tests is ~8h PER BACKEND — ~16h for the pair. (An earlier estimate of 2h10m
# was wrong: it read the runner's "Chunk N/16" lines as chunks COMPLETED, but
# vitest prints them as each shard file STARTS, all within the first minutes.)
#
# The filter keeps every area where the two backends actually diverge:
#   with / unscopables  the `with`-scope unsoundness (#4409) — the only
#                       divergence that reaches a LOWERING decision
#                       (`staticJsTypeOf → number` on a with-scoped name)
#   annexB, eval-code   B.3.3 hoisting and the eval'd-program binding rows
#                       that dominate `valueDeclarationOf` (#4410 A4)
#   resizable-buffer,   the Array callback signature rows
#   fromAsync           and the `let closed` mis-resolution (#4410 A1)
# 3,512 tests — ~36 min per backend. Everything outside it queried the two
# backends identically in the differential run, so it cannot discriminate.
# A FULL standalone A/B belongs in CI (test262-sharded.yml), not this box.
export TEST262_PATH_FILTER="with|unscopables|eval-code|annexB|resizable-buffer|fromAsync"
set -u
cd "$(dirname "$0")/.." || exit 1
S="${JS2WASM_AB_OUT:-$PWD/.tmp/oracle-ab}"
mkdir -p "$S"
R="$PWD/benchmarks/results"
OUT="$S/shards"
mkdir -p "$OUT"

log () { echo "[$(date -u +%H:%M:%S)] $*"; }

# The runner unconditionally appends a summary row to
# benchmarks/results/runs/index.json — the COMMITTED history that feeds the
# report page's trend graph. It has no notion of a scoped run, so each of
# these 32 shard invocations would post a partial result (shard 1 wrote
# "pass: 1902 / total: 2713") next to real ~30k-test runs and bend the graph.
# Treat the file as read-only for this experiment: restore it after every
# invocation. Worth fixing upstream — a local scoped run should not be able to
# write a published artifact at all — but not on a branch with a queued PR.
restore_index () { git checkout -- benchmarks/results/runs/index.json 2>/dev/null || true; }

run_shard () {
  local backend="$1" n="$2"
  local dest="$OUT/$backend-shard$n.jsonl"
  if [ -s "$dest" ]; then
    log "skip $backend/shard$n ($(wc -l < "$dest") rows already on disk)"
    return 0
  fi
  rm -rf /tmp/js2wasm-test262.lockdir
  local before
  before=$(date +%s)
  TEST262_TARGET=standalone JS2WASM_EVAL_ENGINE=quickjs \
  JS2WASM_ORACLE_BACKEND="$backend" COMPILER_POOL_SIZE=3 TEST262_REPORTER=dot \
  TEST262_LOCAL_SHARD_GLOB="tests/test262-local-shard$n.test.ts" \
    pnpm run test:262 > "$S/shard-$backend-$n.log" 2>&1
  local rc=$?
  # Newest results file written since this invocation started.
  local newest
  newest=$(find "$R" -maxdepth 1 -name 'test262-standalone-results-*.jsonl' -newermt "@$before" -print 2>/dev/null | sort | tail -1)
  if [ -n "$newest" ] && [ -s "$newest" ]; then
    cp "$newest" "$dest"
    log "done $backend/shard$n rc=$rc rows=$(wc -l < "$dest")"
  else
    log "FAILED $backend/shard$n rc=$rc — no results file; see shard-$backend-$n.log"
  fi
  restore_index
}

for backend in checker inhouse; do
  for n in $(seq 1 16); do
    run_shard "$backend" "$n"
  done
done

# ── Merge + diff ──────────────────────────────────────────────────────
for backend in checker inhouse; do
  cat "$OUT/$backend-shard"*.jsonl > "$S/t262-sa-$backend.jsonl" 2>/dev/null
  log "$backend total rows: $(wc -l < "$S/t262-sa-$backend.jsonl" 2>/dev/null || echo 0)"
done

missing=$(ls "$OUT"/checker-shard*.jsonl 2>/dev/null | wc -l)
missing2=$(ls "$OUT"/inhouse-shard*.jsonl 2>/dev/null | wc -l)
log "shards present: checker=$missing/16 inhouse=$missing2/16"
if [ "$missing" -ne 16 ] || [ "$missing2" -ne 16 ]; then
  log "INCOMPLETE — re-run this script to fill the gaps before trusting any diff"
  exit 1
fi

npx tsx scripts/diff-test262.ts "$S/t262-sa-checker.jsonl" "$S/t262-sa-inhouse.jsonl" --all \
  > "$S/t262-sa-ab-diff.txt" 2>&1
log "diff exit=$? — see t262-sa-ab-diff.txt"
restore_index
log "COMPLETE"
