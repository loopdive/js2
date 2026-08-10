---
id: 689
title: "Dynamic worker pool: memory-aware scaling with dead worker recovery"
status: done
created: 2026-03-20
updated: 2026-08-09
completed: 2026-04-14
priority: high
feasibility: medium
goal: test-infrastructure
sprint: 0
required_by: [690, 691, 692]
files:
  scripts/run-test262.ts:
    breaking:
      - "dynamic worker pool with memory-aware scaling"
---
# #689 — Dynamic worker pool: memory-aware scaling with dead worker recovery

## Status: open

## 2026-08-09 — dead-worker recovery completed

Two consecutive merge-queue runs exposed the unresolved dead-worker case in
the authoritative Test262 pool:

- run `31326495685` lost 195 standalone rows after shard 16's worker reached
  the 512 MiB V8 heap ceiling;
- run `31328183866` lost 210 standalone rows after the same failure in shard
  18.

Both shard jobs returned Vitest exit code 1, which the workflow deliberately
accepts for ordinary conformance failures, so they uploaded partial JSONL
artifacts as successful. The aggregate denominator guard caught both, but the
pool had left the dead worker's in-flight promise unresolved and abandoned the
rest of each shard.

`CompilerPool` now owns the active job and timer for every fork. An unexpected
worker error/exit requeues that job once on a fresh process. If the same job
kills its replacement, the pool records a bounded `compile_error`, replaces
the worker again, and continues the queue. This implements requirements 2 and
3 without hiding deterministic OOMs or permitting incomplete shard artifacts.
A deterministic crash-worker fixture covers the retry bound and verifies that
subsequent queued work completes on the replacement process.

POOL_SIZE is currently a fixed number (default 4). Workers can OOM on heavy tests, and their remaining batch is lost until retry phase.

### Requirements
1. **Memory-aware pool sizing**: Before spawning a worker, check `os.freemem()`. Only spawn if free memory > 1.5GB (enough for one worker + headroom). POOL_SIZE becomes a max, not fixed.
2. **Dead worker detection**: If a worker process exits unexpectedly (not timeout), immediately redistribute its remaining tests to surviving workers or spawn a replacement.
3. **Live reassignment**: When a worker dies mid-batch, its unfinished tests are pushed back to a shared queue. The next available worker picks them up.
4. **Graceful degradation**: If memory is too low for any workers, wait and retry. Log memory state.

### Approach
```typescript
const MAX_WORKERS = parseInt(process.env.TEST262_WORKERS || "4", 10);
const MIN_FREE_MEM_MB = 1500; // don't spawn if less than 1.5GB free

function canSpawnWorker(): boolean {
  const freeMB = os.freemem() / 1024 / 1024;
  return freeMB > MIN_FREE_MEM_MB;
}

// Instead of fixed chunks, use a work-stealing queue:
// - Main thread holds a queue of test jobs
// - Each worker pulls N tests at a time (e.g., 50)
// - When a worker finishes its batch, it pulls more
// - When a worker dies, its in-flight tests return to the queue
```

### Benefits
- No more lost batches from OOM workers
- Adapts to available memory (works with 8GB or 20GB containers)
- Agents and test262 can coexist without manual tuning

## Complexity: M
