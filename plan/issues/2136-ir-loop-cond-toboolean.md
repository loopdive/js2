---
id: 2136
title: "IR loop conditions: lower non-i32 conds through ToBoolean instead of bailing to legacy"
status: done
completed: 2026-06-17
assignee: ttraenkler/dev-resume
sprint: 63
created: 2026-06-12
updated: 2026-06-17
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: feature
area: compiler
language_feature: loops
goal: ir-adoption
related: [1980, 1804]
origin: "2026-06-12 sprint-62 architecture analysis (IR workstream N3)"
---

# #2136 — numeric-truthiness loops should claim, not demote

## Problem

#1980's fix direction is bail-to-legacy for `while (k)` with an f64
condition (which previously emitted `i32.eqz` on f64 → invalid Wasm that
bricked the module). Bailing keeps those loops permanently in the
`body-shape-rejected` fallback bucket.

## Approach

Lower non-i32 loop conditions via the same coercion the `if`/ternary path
already uses (`from-ast.ts:620-623` pattern, `f64 != 0`), so the loop
claims and runs correctly through IR.

## Acceptance criteria

- `while (k)` with `k: number` claims through IR and runs correctly
  (test alongside #1980's regression guard).
- `body-shape-rejected` bucket does not grow; ideally shrinks.

## Notes

Routine dev work (no Fable needed); sequence after #1980's correctness fix
lands.

## Resolution (2026-06-17, PR for #2136)

Fixed in `src/ir/from-ast.ts`. New `coerceLoopCondToBool(condValue, cx, kind)`
helper: an i32 condition passes through; an **f64** condition is coerced to an
i32 bool via the NaN-safe ToBoolean `abs(x) > 0` (`f64.abs; f64.const 0;
f64.gt` — `-0`→0, `NaN > 0` is false, matching #1937 and the linear backend's
`emitTruthyCoercion`); any other type (ref/string) still bails to legacy with
the same diagnostic (out of #2136's numeric scope). `lowerWhileStatement` and
`lowerForStatement` now call it **inside** the cond-buffer `collectBodyInstrs`
closure (so the coercion re-runs each iteration) and use the coerced i32 SSA
value as `condValue`, replacing the #1980 bail-to-legacy throw. The
`while.loop`/`for.loop` verifier rule (i32 `condValue`, #1850) is satisfied
because the coercion yields an i32.

## Test Results

- `tests/issue-2136.test.ts` (new) — 5/5 pass: `while (k)` / `for (;k;)` with an
  f64 counter run correctly AND record **no** "condition must be bool"
  post-claim demotion (i.e. they claim through IR); falsy `0` and `NaN`
  conditions skip the body; an i32-comparison loop still claims unchanged.
- `tests/issue-1980.test.ts` — 5/5 pass (correctness regression guard).
- `pnpm run check:ir-fallbacks` — OK; `body-shape-rejected` and post-claim
  buckets unchanged (no growth).
- Pre-existing, unrelated failures (confirmed identical on pristine
  upstream/main): the `ir-*-equivalence` / `i32-loop-inference` suites fail on a
  minimal-ENV harness gap (`__unbox_number` / `string_constants` imports not
  supplied); `loop-condition-falsy` / `for-loop-computed-values` import a
  missing `./helpers.js`. None touched by this change.
