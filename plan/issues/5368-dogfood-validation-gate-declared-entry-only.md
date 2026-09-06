---
id: 5368
title: "`check:dogfood-validation` compiles only each package's declared entry module — a subpath that emits invalid Wasm (`hono/dist/utils/color.js`, #5339) passes the gate green"
status: ready
sprint: current
created: 2026-09-06
updated: 2026-09-06
priority: high
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: infra
area: ci
goal: correctness
---

## Problem

`scripts/check-dogfood-validation.mjs` (#5336, required inside `quality`)
asserts `compile.success ⇒ validates` — but only for each package's
**declared entry module** (`<pkg>/dist/index.js`). A module the dogfood suite
admits through a subpath is never compiled by the gate.

#5339 is the measured miss: hono's `dist/utils/color.js` compiled to a module
that failed `WebAssembly.compile` (`type error in return[0] (expected i32,
got externref)` in `getColorEnabledAsync` — an inlined IIFE's `return`
inside a `catch` clause left as a Wasm `return`), and **with that source
restored the gate exits 0**. The invalid module was live on `main` with the
gate green; it surfaced only as a whole-file `0/8` in the hono suite, where
four agents had already misread the null `wasmError`.

## Acceptance criteria

1. The gate is **red** on the parent of #5339's fix (PR #5676) and green
   after it — demonstrate both runs.
2. It covers every module the dogfood suites admit, not just the declared
   entry: the union of modules the suite runner compiles for each package
   (the generated trees `.<pkg>-upstream-suite-generated/` enumerate exactly
   that), or the package's exported subpath map — whichever the runner
   already knows how to enumerate.
3. Wall-clock stays inside the `quality` budget: ≤ 2× today's ~26 s, or
   packages run in a worker pool (`cores − 1`). Quote before/after timings.
4. On failure the message names the package, the module path, and the
   validation error verbatim.

## Implementation Plan

1. Read the gate script and `tests/dogfood/upstream-suite-runner.mjs`'s
   module enumeration (`UPSTREAM_TEST_EXPORTS`, the generated-tree layout).
   Reuse the runner's enumeration rather than re-deriving `exports`
   conditions from `package.json`.
2. Compile every enumerated module with the same options the suite uses;
   fail on any `success && !validates`. Keep compile-error modules out of the
   verdict (they are a different gate's business) but count them in the
   summary line.
3. Parallelise per package if the budget needs it; keep output deterministic
   (sorted by package, then path).
4. Verify AC 1 by checking out #5676's parent in a detached worktree under
   `<repo>/.claude/worktrees/`, running the gate there (red), then on main
   (green). Record both in the PR body.
5. `.github/workflows/**` is untouched (the gate is already wired); if a
   workflow change is needed after all, expect the `needs-manual-enqueue`
   label (#3584) — a lead action, not a hold.

## Dispatch

Model: **opus** (small CI change; opus rather than sonnet because the
mandatory step-0 base recipe on this box has stalled two sonnet agents).
