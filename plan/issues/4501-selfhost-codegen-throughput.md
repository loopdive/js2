---
id: 4501
title: "Whole-program self-compile times out in codegen (>20 min for src/index.ts) — the last blocker after the front-end fixes"
status: ready
sprint: current
created: 2026-08-15
updated: 2026-08-15
priority: high
horizon: l
feasibility: medium
reasoning_effort: max
task_type: performance
area: codegen
goal: self-hosting-dogfood
---

# #4501 — self-host codegen throughput

After #4452 (tsconfig-derived checker options) the compiler's front-end
accepts ALL of its own source. Final sweep 2026-08-15 (22 entries, 270 s
per-entry cap): 16 engine-valid, 0 invalid, 0 front-end failures — and 6
timeouts, all whole-program-scale entries (`index.ts`, `compiler.ts`,
`runtime.ts`, `resolve.ts`, `wit-generator.ts`,
`compiler/early-errors/index.ts`). Measured during #4452: these clear the
front end in ~195–224 s and then run **>20 minutes into codegen** without
finishing. Codegen throughput at ~780-file scale is now the only blocker to
"js2wasm compiles js2wasm".

## Implementation Plan (Fable, 2026-08-15) — measurement FIRST

This is a profile-then-fix issue. Do not optimize anything before step 3.

1. **Get one honest end-to-end number**: `compileFiles("src/resolve.ts")`
   (smallest of the six) with NO timeout, `--cpu-prof` enabled
   (`NODE_OPTIONS="--cpu-prof --cpu-prof-dir=.tmp/prof"`), on an otherwise
   idle box. Record wall, peak RSS, and whether it completes at all —
   "slow" and "non-terminating (quadratic+)" are different bugs.
   `.tmp/prof-summary.mjs` in this worktree summarizes cpuprofiles.
2. **Attribute by phase**: the pipeline logs/knows its phase boundaries
   (front-end / per-function codegen / finalize / binaryen). If phase
   timestamps aren't already emitted, add temporary stderr timestamps in a
   scratch copy (never committed). Determine whether time is in one
   monolithic phase or spread.
3. **Rank self-time from the profile** and characterize the top ≥60% by
   growth class: per-function cost (linear, just a lot of functions) vs
   super-linear hot spots (per-function scans over the whole module —
   candidate smells from this session's work: whole-module struct scans in
   dispatch voting, import-table rebuilds, `funcMap` linear lookups,
   stack-balance fixups over full bodies, IR verify passes with quadratic
   audits accidentally on).
4. **Fix in measured order**, one lever per commit, each A/B'd on
   `resolve.ts` wall time + the equivalence-gate; the compile-speedup lane's
   discipline applies (byte-identical output is NOT required here, but
   test262/equivalence green is).
5. **Acceptance floor**: `compileFiles("src/index.ts")` completes to an
   engine-valid module in under 10 minutes on a 4-core box, and the sweep's
   six timeout entries all complete. Stretch: under 5.
6. **Out of scope**: parallelizing codegen across workers (architecture
   change — file separately if the profile says single-thread ceilings are
   the wall after the algorithmic fixes).

## Acceptance criteria

- [ ] Phase/self-time profile of one whole-program compile recorded in
      Results (numbers, not adjectives).
- [ ] Each landed lever named with its measured before/after on
      `resolve.ts`.
- [ ] All six sweep-timeout entries compile to engine-valid modules; wall
      times recorded.
- [ ] Equivalence + test262 gates green (merge queue authority).
