---
id: 1950
title: "Default-on optimization — default builds ship unoptimized; add -O default where Binaryen is present plus tiny always-on cleanups"
status: done
sprint: 63
created: 2026-06-10
updated: 2026-06-16
completed: 2026-06-16
assignee: ttraenkler/tld-1921
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

## Resolution (2026-06-16)

Flipped the **CLI** default to optimized output (approach step 1, the headline
acceptance criterion). Dependency #1941 (differential testing of `--optimize`
output) is **done** (PR #1323), so the blast-radius prerequisite is satisfied.

- **`src/cli.ts`**:
  - `optimize` now defaults to `3` (was `false`) — a bare `js2 build foo.ts`
    runs `wasm-opt` at `-O3` when binaryen is present.
  - Added `--no-optimize` / `-O0` to opt out (raw codegen output).
  - Updated `--help` text.
- **`src/compiler.ts` / programmatic `compile()` API**: unchanged. The library
  default stays opt-out (`options.optimize` falsy ⇒ no wasm-opt) so embedding
  js2wasm has no surprise behaviour change, per the approach. Library users opt
  in with `{ optimize: 3 }`.
- **`docs/cli.md`**: documents default-on + `--no-optimize`, and the
  CLI-vs-API distinction.

Graceful degradation already handled (`optimize.ts`): when neither npm binaryen
nor system `wasm-opt` is present, the build emits a one-line warning and ships
the unoptimized binary — default-on never turns absence into a failure.

### Scope notes

- **Acceptance criterion 2 (playground sizes / perf sidebar)** is already
  satisfied by existing infrastructure: the benchmark/size generators
  (`scripts/generate-playground-benchmark-sidebar*.mjs`,
  `scripts/generate-size-benchmarks.ts`) already run `optimizeBinaryAsync`
  (level 4) before measuring, so the published sidebar/size figures already
  reflect optimized output. No change needed there.
- **Approach step 3 (always-on in-compiler const-folding + dead convert/drop
  removal)** is deliberately deferred to a follow-up: it is orthogonal to the
  default-on flip (it helps only the no-binaryen path), and adding new
  always-on codegen passes carries its own correctness risk that warrants a
  separate, focused PR. This PR delivers the headline value (default builds
  are now optimized) cleanly.

## Test Results

- `tests/issue-1950-default-optimization.test.ts` — 2/2 pass:
  - Default CLI build (standalone target) is smaller than `--no-optimize`
    (2,690 vs 9,754 bytes locally) and both compute `test(5) === 20` — optimized
    output stays correct.
  - `-O0` produces byte-identical output to `--no-optimize`.
- Existing CLI suites (`issue-1554`, `issue-1590`, `issue-1775`, `issue-1580`)
  pass with the new default (16/16).
- `npm run typecheck` and `npm run lint` (Biome) clean.

## Source

Compiler quality review 2026-06. Depends on #1941. Related: #1949.
