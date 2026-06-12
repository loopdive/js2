---
id: 1950
title: "Default-on optimization — default builds ship unoptimized; add -O default where Binaryen is present plus tiny always-on cleanups"
status: ready
sprint: 62
created: 2026-06-10
updated: 2026-06-12
priority: medium
feasibility: easy
reasoning_effort: medium
task_type: performance
area: compiler
language_feature: n/a
goal: performance
---
# #1950 — Default-on optimization pipeline

## Problem

- `optimize` defaults to **off** (`src/cli.ts:102`, `compiler.ts:447`), so
  every consumer who doesn't pass `-O` — including the playground and most
  doc examples — ships unoptimized output. The 2026-06 review's probe
  showed Binaryen -O3 doing materially valuable, safe work the in-compiler
  passes don't: inlining small functions, tracking `array.len` into locals,
  null-check cleanup post-inline, and eliminating a dead
  `f64.convert; drop` pair the peephole misses.
- The always-on in-compiler tail has only 6 peephole patterns and no
  constant folding; 3 of its 6 passes are fixups, not optimizations
  (`src/codegen/index.ts:1559-1575`).

## Proposed approach

1. **Flip the default where Binaryen is available**: CLI and playground
   paths run `optimize: 1` by default with `--no-optimize` opt-out; keep
   `optimize: false` for the test-suite default (tests assert on raw
   patterns) and for programmatic API (no surprise behavior change for
   library users — document the recommendation instead). Decide exact
   surface with the user/PO in the PR.
2. Keep graceful degradation when neither npm binaryen nor system wasm-opt
   exists (already handled, `optimize.ts:411-424`) — default-on must not
   turn absence into failure, just a one-line note.
3. Add two cheap always-on cleanups to the in-compiler tail (orthogonal to
   Binaryen, helps the no-binaryen path): per-function const folding of
   `f64.const/i32.const` arithmetic, and dead `convert/drop` pair removal
   (the patterns the probe caught).
4. **Hard dependency: #1941 must land first** — making `-O` the default
   without differential coverage of optimized output widens the blast
   radius of any wasm-opt miscompile.

## Acceptance criteria

- `js2 build foo.ts` output is wasm-opt-processed when binaryen is present;
  `--no-optimize` restores current behavior.
- Playground binary sizes/perf sidebar reflect the change (expect
  improvement); benchmark gate green.
- Blocked-by relationship to #1941 recorded and respected.

## Source

Compiler quality review 2026-06. Depends on #1941. Related: #1949.
