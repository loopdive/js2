---
id: 6742
title: "npm-compat standalone lanes: budget-aware wasm-opt level, recorded per lane — a valid module never ends in optimization-error"
status: done
sprint: current
created: 2026-09-29
updated: 2026-09-29
completed: 2026-09-29
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: npm-compat, optimizer
goal: standalone
requested_by: ttraenkler/sendev-standalone
related: [4157, 4586, 6732, 6737, 6746]
files:
  - src/optimize.ts
  - scripts/lib/npm-compat-opt-budget.mjs
  - scripts/lib/npm-compat-perf.mjs
  - scripts/generate-npm-compat-report.mjs
  - scripts/compiler-extension-boundaries.json
  - tests/issue-6742-wasm-opt-budget.test.ts
  - tests/issue-4585-npm-compat-refresh-resilience.test.ts
---

# #6742 — budget-aware wasm-opt level for the standalone lanes

## Problem

The npm-compat standalone lanes always ask Binaryen for `-O4`. Two packages
show why that cannot hold for every module:

- **axios** (`standalone-dynamic`): the raw module is valid (9,260,766 B), but
  `-O4` aborts in Binaryen's Flatten pass on `try_table`, and the #4586 retry
  without Flatten runs past the 600 s wasm-opt timeout. The lane reports
  `optimization-error`, and the retry's own failure is cut off behind
  Binaryen.js's source dump (#6732).
- **lodash-es**: `-O4` is ≈75 % of a 352 s lane (#6737). CI's bounded child
  budget for a host-blocked package is 120 s.

Binaryen's npm `wasm-opt` is a single-threaded Emscripten build, so its cost
tracks the raw module size.

## Measured (2026-09-29, Binaryen 132 npm `wasm-opt`, `/usr/bin/time` CPU)

Raw modules are the `standalone-dynamic` lane drivers compiled with
`optimize: 0` on `c8b4f0ef36`. Box load was 110–390 on 8 cores for the whole
run, so wall time was 3–7× CPU time. The table uses CPU seconds, which are
close to what an idle machine would take. "O4" means `-O4 --skip-pass=flatten`;
the aborted first `-O4` run cost another 3.7 / 13.5 / 9.5 / 13.4 CPU-s.

| package | raw | O1 | O2 | O3 | O4 |
|---|---:|---:|---:|---:|---:|
| hono | 1,198,739 B | 9.2 s · 700,287 B | 19.4 s · 628,989 B | 28.7 s · 605,863 B | 30.0 s · 604,406 B |
| moment | 2,688,019 B | 16.7 s · 1,906,795 B | 51.1 s · 1,840,535 B | 66.6 s · 1,819,542 B | 68.3 s · 1,816,804 B |
| lodash-es | 5,822,763 B | 38.4 s · 4,233,275 B | 122.1 s · 3,842,673 B | 233.9 s · 3,632,177 B | 251.8 s · 3,627,787 B |
| axios | 9,260,766 B | 56.8 s · 5,565,338 B | 140.8 s · 4,196,091 B | killed at 3,600 s wall | killed at 3,600 s wall (load 29 at start); ≈38 min in #6732 · 3,820,273 B |

Runtime speed (wasm-only, interleaved rounds, same seed, median µs/op, all
checksums equal):

| package | raw | O1 | O2 | O3 | O4 |
|---|---:|---:|---:|---:|---:|
| hono | 17.4 | 16.4 | 21.3 | 11.9 | 15.7 |
| moment | 5,411 | 3,807 | 3,712 | 4,088 | 3,886 |
| lodash-es | 216 | 269 | 234 | 285 | 248 |

Under this load, O1–O4 are within noise of each other on all three packages.
The only clear effect is moment's raw module being ~40 % slower. Level mostly
changes **binary size**: O2 is +1–6 % over O4, and O1 is +16–46 %. **O3 costs
about as much as O4 without Flatten** (hono 28.7 vs 30.0 s, moment 66.6 vs
68.3 s, lodash-es 233.9 vs 251.8 s), because O4 = O3 plus `flatten`,
`simplify-locals-notee-nostructure` and `local-cse` (from a `BINARYEN_PASS_DEBUG`
pass listing). So O3 cannot rescue an O4 timeout.

Cost is **superlinear** in module size above ~6 MB. Per raw MB, O3/O4 cost
24–25 CPU-s on hono and moment but 40–43 on lodash-es. On axios, both O3 and
O4 without Flatten ran past a 1-hour wall limit. The second of those runs
started at load 29, when the box was nearly idle. By contrast, O2 on axios
took 140.8 CPU-s. That is why the O4 ceiling is a hard 7 MB and not a
per-MB estimate.

## Implementation Plan (executed)

1. `src/optimize.ts`
   - `OptimizeOptions.timeoutMs`: a per-invocation wall-clock limit for the
     CLI, default 600 s as before. `OptimizeResult.timedOut` is set when the
     run hits it.
   - `wasmOptFailure()` reduces a failed run to readable lines. It drops the
     Emscripten source-line dump, the caret line and the JS stack. A timeout
     reads `wasm-opt timed out after N ms`. The #4586 retry's failure now
     comes **first** (`retry without flatten failed: …`), so the 800-char
     cut can no longer drop it. This covers the diagnostics half of #6732.
   - Successful output is unchanged: base and fix give the same hash for
     `gc`/`standalone` × `-O2/-O3/-O4`.
2. `scripts/lib/npm-compat-opt-budget.mjs` (new)
   - Size plan: raw ≤ 7 MB → O4, ≤ 12 MB → O2, else O1. The ladder is
     4 → 2 → 1, skipping O3 for the reason above.
   - Failure or timeout steps down one rung. If every rung fails, the lane
     measures the raw module as `optimizationLevel: 0`,
     `optimizationVerified: false`. It never reports an error for a valid
     module.
   - Deadline mode, for a bounded child: a non-final rung gets at most 60 %
     of the time left. A rung is skipped outright when its measured CPU floor
     (O4 25, O3 23, O2 15, O1 6 s per raw MB) cannot fit.
   - The record carries `optimizationLevel` (the level that produced the
     artifact), `optimizationLevelRequested`, `optimizationLevelReason`,
     `optimizationAttempts[]`, `rawBinaryBytes` and `optimizeDurationMs`.
   - `optimizationReceiptHolds()` is the report's receipt check. A lowered
     level passes only when its last attempt produced it.
3. `scripts/generate-npm-compat-report.mjs`
   - `compileNpmCompatPerfLane` compiles standalone lanes with
     `optimize: false`, then runs the budgeted optimizer.
   - `compileDurationMs` still includes optimization. Every post-compile
     failure record reports the actual level.
   - `standaloneLaneInChild` passes `--lane-budget-ms`. The child keeps 25 %
     of it for instantiation and measurement.
   - JS-host lanes are untouched and keep the integrated O4 request.
4. `scripts/compiler-extension-boundaries.json`: the `optional-binaryen-provider-v1`
   record gets the new `src/optimize.ts` content hash. `getBinaryenModule` is
   unchanged and re-reviewed.

## Resolution

Lanes are `standalone-dynamic`, run locally one at a time at the same load.

| lane | before (`c8b4f0ef36`) | after |
|---|---|---|
| axios | `optimization-error` after 837,661 ms: `wasm-opt -O4 failed: unexpected expr type … Flatten.cpp:231! Aborted() … var Module=typeof Module…` (retry reason cut off) | **no optimizer error.** Planned `-O2` (raw 9,260,766 B > the 7 MB O4 ceiling). `-O2` timed out at 600 s under load, and `-O1` produced 5,565,338 B, recorded `optimizationLevel: 1`. Next gate: `host-import-error: standalone binary retained 57 host import(s)` (23 at `-O2`) → [#6746](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6746-standalone-axios-retained-host-imports) |
| lodash-es | `optimization-error` after 902,967 ms: same Flatten text; the retry was killed at 600 s under load | **`measured`**, checksum 54 = 54, 0 imports. `-O4` timed out at 600 s under load, and `-O2` produced 3,842,673 B, recorded `optimizationLevel: 2`, `optimizationLevelReason: "-O4 timed out"`. On an unloaded box, `-O4` (251.8 CPU-s) is expected to finish. |

Both "after" runs were at load 30–390 on 8 cores. That is why both lanes
stepped down a rung. The attempt log records each step.

Tests: `tests/issue-6742-wasm-opt-budget.test.ts`.

- Parent `src/optimize.ts`: 2 of the 2 optimizer tests fail (the timeout
  test and the retry-text test).
- Parent tree: the whole file fails, because the new module does not exist
  there.
- Fix: 10 / 10 pass. This includes a real `try_table` fixture through the
  lane optimizer at O4 (Flatten omitted), and the same fixture at a
  budget-lowered O2. Both run correctly.

## Residuals

- The aborted first `-O4` run is still paid on every `try_table` module
  (3.7–13.5 CPU-s here). Skipping it needs an exact "module uses
  `try_table`" signal. The optimizer only sees bytes, and a heuristic would
  change JS-host output.
- CI's 120 s child budget for a host-blocked package is often smaller than
  codegen alone (axios codegen ≈ 300 s wall here). Such a lane now ends
  `measured` at level 0 or `compile-budget`. It no longer ends in
  `optimization-error`. Raising the budget is a separate call.
