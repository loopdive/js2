---
id: 3102
title: "LOC regrowth ratchet: check:loc-budget CI gate for god-files"
status: ready
sprint: Backlog
created: 2026-07-09
updated: 2026-07-09
priority: high
horizon: s
feasibility: medium
model: opus
reasoning_effort: medium
task_type: infrastructure
area: ci, codegen
language_feature: compiler-internals
goal: maintainability
related: [1013, 1172, 3103, 3104]
---

# #3102 — LOC regrowth ratchet: `check:loc-budget` CI gate

**Source:** 2026-07-09 compiler consolidation audit (fable-refactor). See
`plan/log/compiler-consolidation-plan.md`.

## Problem (measured)

Splitting god-files does not stick. Every past split has regrown, because
nothing structurally prevents new code from landing in the biggest file:

| File                   | #1013 split (2026-04-10) | #1172 audit (2026-04-25) | 2026-06-27 | 2026-07-09 |
| ---------------------- | ------------------------ | ------------------------ | ---------- | ---------- |
| `src/codegen/index.ts` | 14,344 → split           | 6,368                    | 14,379     | **16,566** |

`codegen/index.ts` regrew **2.6×** in ten weeks after the #1013 split.
And in just the last 12 days (2026-06-27 → 2026-07-09, measured via
`git show bf56e3060:<file> | wc -l` vs current):

| File                               | Jun 27 | Jul 9  | Δ 12 days           |
| ---------------------------------- | ------ | ------ | ------------------- |
| `src/codegen/expressions/calls.ts` | 15,292 | 17,246 | **+1,954 (+12.8%)** |
| `src/codegen/index.ts`             | 14,379 | 16,566 | **+2,187 (+15.2%)** |
| `src/codegen/object-runtime.ts`    | 7,834  | 9,726  | **+1,892 (+24%)**   |
| `src/runtime.ts`                   | 13,959 | 15,032 | **+1,073 (+7.7%)**  |

Four files absorbed **+7.1k LOC in 12 days**. Current state: 246 `.ts` files in
`src/` (309,130 LOC), **13 files >5,000 LOC**, 28 files >3,000 LOC, and 27
top-level functions ≥1,000 lines (worst: `compileCallExpression` at 12,210).

Every consolidation issue in this plan (#3103, #3104, …) is wasted effort
without a regrowth brake. The project already has the exact mechanism proven:
the IR fallback ratchet (#1376) — baseline JSON, CI fails on growth,
`--update-on-decrease` banks shrinkage.

## Fix

Add `scripts/check-loc-budget.mjs` + `pnpm run check:loc-budget`, wired into
the `quality` CI job (same slot as `check:ir-fallbacks`):

1. **Baseline** `scripts/loc-budget-baseline.json`: `{ "<path>": <maxLines> }`
   for every `src/**/*.ts` file currently over a threshold (propose **1,500
   LOC**), captured from current main.
2. **Gate**: fail when
   - a baselined file exceeds its recorded ceiling (regrowth), or
   - a NON-baselined src file crosses the threshold (new god-file).
     Print the offending file, the delta, and a pointer to the consolidation
     plan ("add code to the subsystem module, not the barrel/driver").
3. **Ratchet**: `--update-on-decrease` rewrites lowered ceilings (call from the
   post-merge CI job, same as the IR ratchet). `--update` for PRs that
   deliberately grow a file (rare; requires the flag in the PR, visible in
   review).
4. Grandfather everything at current size — the gate blocks _growth_, it does
   not demand immediate shrinkage, so it can merge with zero refactoring.

Optional slice 2 (separate PR, same script): a per-function ceiling for the
named god-functions (`compileCallExpression`, `ensureObjectRuntime`,
`resolveImport`, `ensureNativeStringHelpers`, `compilePropertyAccess`) using a
cheap top-level-function line scan, so those five can't grow either.

## Safety

Pure tooling — zero compiler-source changes, zero effect on emitted Wasm.
No byte-identity proof needed. Risk is CI friction only; the grandfathered
baseline plus `--update` escape hatch caps that.

## Estimated LOC delta

+~200 (script) / prevents unbounded growth of ~75k LOC across the 13 giants.

## Acceptance criteria

1. `pnpm run check:loc-budget` passes on unmodified main.
2. Adding 1 line to `src/codegen/index.ts` makes it fail with an actionable message.
3. Shrinking a baselined file + `--update-on-decrease` rewrites the baseline.
4. Wired into `quality` job; post-merge job banks decreases.
