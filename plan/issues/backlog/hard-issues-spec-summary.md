---
title: Hard-issue Implementation Plan summary
created: 2026-05-21
author: architect (task #101)
---

# Hard-issue spec audit (2026-05-21)

This file tracks which `feasibility: hard` issues in `backlog/`
have an `## Implementation Plan` or `## Architect …` section, who
authored it, and which were intentionally skipped.

## Issues with a spec written or refined today

| Issue | Title | Spec type | Status | Spec depth |
|-------|-------|-----------|--------|------------|
| 983   | WasmGC objects leak to JS host | Implementation Plan | ready | full |
| 1552  | Tagged-union value rep (retire box/unbox/typeof) | Implementation Plan | backlog | full |
| 746   | Inline property tables / hidden classes | Implementation Plan | blocked | full |
| 743   | Whole-program type-flow analysis | Implementation Plan | ready | full |
| 684   | Any-typed variable inference from usage | Implementation Plan | ready | full |
| 1104  | Wasm-native Error construction | Architect refinement | suspended | refinement |
| 820   | Nullish TypeError umbrella | Implementation Plan | ready | umbrella → sub-issues |
| 739   | Object.defineProperty correctness | Implementation Plan | ready | full |
| 1100  | Wasm-native Proxy | Implementation Plan | ready | full |
| 1101  | Wasm-native WeakRef / FinReg | Implementation Plan | ready | full |
| 1102  | Wasm-native eval AOT | Implementation Plan | ready | full |
| 1105  | Wasm-native String methods (Tier 1) | Implementation Plan | ready | full |
| 1116b | Wasm class as JS ctor bridge | Implementation Plan | ready | full |
| 1130  | Array methods getter-observing | Implementation Plan | ready | full |
| 1199  | Linear-memory backing for typed numeric arrays | Architect refinement | ready | refinement |
| 1257  | async-gen funcIdx shift detached arrays | Implementation Plan | backlog | full |
| 682   | RegExp standalone engine (libregexp) | Implementation Plan | ready | full |
| 1539  | Opt-in Wasm-native RegExp (regress port) | Implementation Plan | backlog | full |
| 1555  | Streaming iterator destructuring | Implementation Plan | ready | full |
| 680   | Wasm-native generators | Implementation Plan | ready | full |
| 735   | Async iteration correctness | Implementation Plan | blocked | full |
| 745   | Tagged-union (per-type) | Implementation Plan | ready | recommends close (superseded by #1552) |
| 747   | Escape analysis | Implementation Plan | blocked | full |
| 652   | Compile-time ARC | Architect refinement | ready | refinement |
| 779   | Assert failures umbrella | Implementation Plan | ready | umbrella → sub-issues |
| 833   | Sloppy-mode support | Implementation Plan | ready | full |
| 1264  | eval tier 4 (strict shadow scope) | Implementation Plan | backlog | full |
| 1265  | eval tier 5 (sloppy boxing) | Implementation Plan | backlog | full + defer recommendation |
| 904   | Link-time specialization | Implementation Plan | ready | full |
| 674   | SharedArrayBuffer + Atomics | Implementation Plan | ready | full |
| 639   | Full Component Model adapter | Implementation Plan | ready | full |

## Issues that already had a plan (pre-2026-05-21) — left untouched

| Issue | Title | Notes |
|-------|-------|-------|
| 1042  | Async-await state machine lowering | per task instruction "skip" |
| 1116  | Promise resolution + async error | per task instruction "skip" |
| 1151  | Async function synchronous throws bypass | per task instruction "skip" |
| 1103  | Wasm-native Map/Set/WeakMap | already specced |
| 1066  | Standalone-mode eval via Wasm child | already specced (2026-05-21) |
| 1089  | Codegen dynamic `import()` | already specced (2026-05-21) |
| 1046  | Separate ES-module compilation | already specced (2026-05-21) |
| 846   | assert.throws not thrown (built-ins) | already specced (2026-05-21) |
| 903   | Typed host import contracts | already specced (2026-05-21) |
| 905   | Versioned shapes for compile-time inference | already specced |

## Issues intentionally skipped (analysis / tracking / integration)

| Issue | Reason |
|-------|--------|
| 1029  | TypeScript 7.x migration — multi-month tracking; not a single-PR codegen change |
| 1032  | Compile axios to wasm — integration validation, not a codegen feature |
| 1033  | Compile react to wasm — integration validation |
| 1059  | Parallel tsc stress test — testing infrastructure |
| 1353  | Spec backlog: memory model — spec analysis tracker |
| 1354  | Spec backlog: SharedArrayBuffer Atomics — duplicate of #674; analysis-only |
| 1355  | Spec backlog: Proxy pure-Wasm — duplicate of #1100; analysis-only |
| 1356  | Spec backlog: ShadowRealm — spec analysis tracker |
| 1563  | ECMAScript spec compliance gap analysis — analysis output, not code |
| 888   | Competitive benchmark matrix — benchmarking work |
| typescript-self-host-tier0-survey | Survey artifact, not an actionable issue |
| 1129  | status: done |
| 1052  | status: in-review (active dev) |
| 1556  | status: spec-done |

## Recommended dispatch order (post-spec)

Highest-leverage first, respecting dependencies:

1. **#1555** (streaming dstr) — unblocks #1542/#1543/#1544 cluster (~250 fails).
2. **#739** (Object.defineProperty) — ~262 fails plus unblocks #983.
3. **#983** (WasmGC objects leak) — bounded scope after re-baselining.
4. **#1257** (funcIdx shift) — small refactor; unblocks several dstr clusters.
5. **#1130** (array getter-observing) — ~80 fails; depends on shared [[Get]] helper.
6. **#1116b** (class-as-JS-ctor bridge) — ~61 Promise fails.
7. **#684** (usage inference) — independent perf win; foundational for #743.
8. **#743** (type-flow) — unlocks #746, #747, #1199, #904.
9. **#746** (hidden classes) — depends on #743.
10. **#1552** (tagged unions) — major perf; coordinate with #1471.
11. **#1102** (eval AOT) → **#1264** (strict shadow) → **#1265** (defer).
12. **Wasm-native built-ins** (#1100, #1101, #1105, #680, #682/#1539) — standalone-mode unlock; parallel-dispatchable.
13. **#639** (Component Model) — ready when #600 lands.
14. **#674** (SAB/Atomics) — low priority; lands when there's demand.
15. **#904** (link-time specialize) — depends on #1046 + #743.
16. **#652** (ARC) — defer until #747 + #743 land.

## Risks called out across multiple plans

- **#1552 vs #745**: competing tagged-union designs. Decide before
  any code ships; recommend keeping #1552 (universal $Value),
  closing #745 as superseded.
- **#682 vs #1539**: competing regex backends (QuickJS libregexp
  vs regress crate). Pick ONE; recommend regress for modern
  Unicode/maintenance.
- **#1104** Phase 2/3 has many edge cases not enumerated in the
  existing plan; the 2026-05-21 architect review flagged
  subclasses, AggregateError, and `error.stack` sidecar handling.
- **#820 sub-issue numbering**: the issue-side "#1552" referring to
  catch-param dstr collides with the global #1552 (tagged unions).
  Rename the dstr one to #1554 before dispatching.

## Notes

- Total hard issues audited: 53.
- Plans added or refined this session: 31.
- Plans previously present: 10.
- Intentionally skipped: 14.
- Coverage gaps: none in the actionable codegen surface.

## Addendum (architect run 2 — 2026-05-21, later)

A second architect pass cross-checked the audit and added the following:

- Detailed `## Implementation Plan` (header explicit) to `#1089` codegen dynamic `import()` (codegen path was already partially complete; the missing piece is the test262 runner + host bridge).
- Added/refined `## Implementation Plan` headers to: `#846` (decomposition into 7 subareas), `#905` (versioned shapes), `#1046` (separate ES-module compilation, milestone breakdown), `#1066` (standalone eval), `#674` (SharedArrayBuffer + Atomics with concrete Wasm output), `#903` (host import contracts), `#1539` (renamed "Architect refinement" → "Implementation Plan").
- Confirmed `#1555`, `#1264`, `#1265`, `#680`, `#682`, `#735`, `#745`, `#747`, `#820`, `#833`, `#1257`, `#1130`, `#1199`, `#1552`, `#1102`, `#1101`, `#1100`, `#1105`, `#1116b`, `#1539`, `#639`, `#652`, `#739`, `#743`, `#746`, `#684`, `#983`, `#904`, `#1104` already had substantive plans authored by earlier architects; left untouched.

All file paths and line references in the new plans are absolute and verified against current main as of 2026-05-21.
