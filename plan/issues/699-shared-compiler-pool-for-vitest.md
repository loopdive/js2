---
id: 699
title: "Shared compiler pool for vitest test262 runner"
status: done
created: 2026-03-20
updated: 2026-07-25
completed: 2026-07-25
priority: high
feasibility: medium
reasoning_effort: high
goal: test-infrastructure
sprint: Backlog
depends_on: [694]
required_by: [700]
files:
  tests/test262-vitest.test.ts:
    breaking:
      - "use shared compiler pool instead of per-test compile()"
  scripts/compiler-pool.ts:
    new:
      - "persistent compiler worker pool with warm ts.Program"
---
# #699 — Shared compiler pool for vitest test262 runner

## Status: DONE — delivered incrementally, closed retroactively 2026-07-25

The pool is live code and has been for a long time; only this issue's status was
stale. Verified against `main` @ `f5749c3` (2026-07-25) — all four implementation
steps below are satisfied, **three of them by a different design than the sketch
in this issue**. Recording the as-built shape, because the deviations are
deliberate and one of them reverses this issue's central perf premise.

### As-built vs. as-designed

| step | as designed here                                     | as built                                                                                          |
| ---- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 1    | `scripts/compiler-worker.ts` in a **worker_thread**  | `scripts/compiler-fork-worker.mjs` (+ `compiler-worker.mjs`) in a **`child_process.fork`**         |
| 2    | `scripts/compiler-pool.ts` pool manager + queue      | ✅ exactly that — `class CompilerPool`, `scripts/compiler-pool.ts`                                 |
| 3    | update the vitest runner to use `pool.compile()`     | ✅ `tests/test262-shared.ts:17,188,547` — `new CompilerPool(POOL_SIZE, "unified")`                 |
| 4    | `reuseHost` option on `compile()` in `src/compiler.ts` | `createIncrementalCompiler()` / `IncrementalLanguageService` (`src/index.ts:796`) — no such option |

**Deviation 1 — forks, not worker threads (intentional).** From the header of
`scripts/compiler-pool.ts`: *"Uses `child_process.fork` (separate OS processes)
instead of worker threads. When a process exits, the OS reclaims ALL its memory
(RSS, JIT code, etc.)."* Memory reclamation across a 48K-test run beat
thread-sharing. Pool size comes from `COMPILER_POOL_SIZE` (consumed by
`tests/test262-shared.ts`, `scripts/precompile-tests.ts`,
`scripts/local-ci.sh`, `scripts/gen-test262-mg-matrix.mjs`).

**Deviation 2 — `reuseHost` never existed.** The warm-host mechanism shipped as
the public `createIncrementalCompiler(defaultOptions?)` API returning
`{ compile, dispose }` over a persistent `IncrementalLanguageService`, not as a
`compile(source, { reuseHost })` flag. Anyone grepping for `reuseHost` will find
nothing — that is expected, not a gap.

**Deviation 3 — ⚠️ `oldProgram` reuse was deliberately REMOVED, which forfeits
part of this issue's headline saving.** #973 ("Incremental compiler state leak —
CompilerPool fork produces ~400 false CEs", done) found that reusing the old
`ts.Program` leaked checker state between compilations and manufactured ~400
false compile errors. `scripts/compiler-fork-worker.mjs:15` records the
resolution: *"With #973 fix (no oldProgram reuse), there's no type leakage
between compilations. Recreate interval is now purely for memory management."*

So the *"saved 50ms lib parsing"* line in **Expected performance** below is
**not** what was achieved — correctness took priority over that specific
saving. The persistent-process win (no fresh node process per compile) and the
warm language service were kept; cross-compile program reuse was not. Treat the
performance figures in this issue as the original estimate, not a measured
result.

Memory hygiene knobs added along the way: `GC_INTERVAL = 25`,
`RECREATE_INTERVAL = 500`, plus immediate fork recycling on emit-layer failures
(#1808).

### Follow-up bugs in the pool (both separate issues)

- **#1227** — pool timeout starts at enqueue time rather than dispatch time,
  producing 156 false `compile_timeout`s.
- **#1230** — post-dispatch fork starvation in the pool (73 phantom timeouts).

### Not covered by this issue

This issue is scoped **only** to the test262 vitest runner. Keeping the compiler
warm for ordinary `js2` CLI invocations, or running it as a long-lived compile
service/daemon for general use, is **not tracked anywhere** as of 2026-07-25.

## Original issue text (as filed 2026-03-20)

### Problem
Each vitest test calls `compile()` which creates a new `ts.Program` (~50ms), new `CodegenContext`, and runs full compilation (~150ms). With 48K tests, this is 48K × 200ms = 160 min single-threaded.

### Solution: Persistent compiler worker pool

```typescript
// compiler-pool.ts
import { Worker } from "worker_threads";

class CompilerPool {
  private workers: Worker[];
  private queue: Array<{ source: string; resolve: Function }> = [];
  
  constructor(size = 4) {
    this.workers = Array.from({ length: size }, () => {
      const w = new Worker("./compiler-worker.ts");
      w.on("message", (result) => { /* return to caller */ });
      return w;
    });
  }
  
  async compile(source: string): Promise<CompileResult> {
    // Find free worker or queue
    return new Promise((resolve) => {
      this.queue.push({ source, resolve });
      this.dispatch();
    });
  }
}

// compiler-worker.ts — runs in worker_thread
import { parentPort } from "worker_threads";
import { compile } from "../src/index.js";

// Create ts.Program ONCE on startup
let cachedHost = null;

parentPort.on("message", (source: string) => {
  const result = compile(source, { reuseHost: cachedHost });
  // Transfer binary zero-copy
  parentPort.postMessage(result, [result.binary.buffer]);
});
```

### Expected performance
- Pool of 4 compiler workers, each with warm ts.Program
- Compilation: ~100ms (saved 50ms lib parsing + 50ms context setup)
- 4 workers × 10 tests/sec = 40 tests/sec
- 48K tests in ~20 min (cold), ~48 sec (warm cache)
- Vitest threads don't block on compilation — async await

### Implementation steps
1. Create `scripts/compiler-worker.ts` — persistent worker with warm program
2. Create `scripts/compiler-pool.ts` — pool manager with queue
3. Update `tests/test262-vitest.test.ts` — replace `compile()` with `pool.compile()`
4. Add `reuseHost` option to `src/compiler.ts` — keep ts.CompilerHost between calls

## Complexity: M
