---
id: 5174
title: "optimize() swallows a wasm-opt abort and returns the unoptimized binary as success — accessor-family prepared modules crash binaryen (type.isStruct, effects.h:650)"
status: ready
sprint: current
created: 2026-08-29
updated: 2026-08-29
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: optimizer, ir
goal: ir-full-coverage
related: [3522, 5199]
origin: "2026-08-29 PR #5199 drive-to-green — root cause of the accessor fixture's 1007-vs-588 size assertion"
---

# #5174 — silent optimizer-abort fallback + accessor-family binaryen crash

## Problem (two halves, the silent one is worse)

1. **wasm-opt ABORTS on prepared accessor-class modules**: compiling the
   GETTER_AND_SETTER fixture (accessor-only nested class, no field call)
   through the prepared path and optimizing crashes binaryen with
   `Assertion failed: type.isStruct(), effects.h:650, writesStruct`. The
   direct path's module optimizes fine (1081 → 588 bytes).
2. **`optimize` swallows the abort and returns the UNOPTIMIZED binary** —
   `optPrepared == rawPrepared` (1007 == 1007) with no error surfaced. A
   crashing optimizer currently reads as a successful compile, so any
   optimizer-legality bug in emitted IR modules is invisible except as a
   size anomaly.

Measured 2026-08-29 on origin/main (byte-identical with and without the F4
slice — this is main's, not #5199's):

| fixture | rawDirect | rawPrepared | optDirect | optPrepared |
| --- | --- | --- | --- | --- |
| METHOD_AND_GETTER | 683 | 690 | 367 | 367 |
| GETTER_AND_SETTER | 1081 | 1007 | 588 | **1007** (unoptimized, abort swallowed) |
| CLASS_EXPRESSION | 4915 | 855 | 4915 | 382 |

Discovery context: the rot was invisible because
`tests/issue-3522-nested-class-accessor.test.ts`'s size row runs only under
fix-on-touch (`test:changed-root` — untouched root test files never run at PR
time, and guard-suite.json has no issue-3522 entry). PR #5199 touched the
file, armed the row, and went red on main's own defect.

## What to do

1. **Un-swallow first** (small, independent): make `optimize`'s
   failure path REPORT — at minimum a structured warning on the compile
   result naming the abort, at best a hard error behind a flag ramp. "A
   detector must be able to say I DON'T KNOW": silently serving the
   unoptimized binary is the unsound arm. Audit src/optimize.ts's
   catch/fallback and any other swallow sites.
2. **Root-cause the accessor crash**: the prepared accessor module emits
   something binaryen's effects analysis considers a struct write on a
   non-struct type. Reduce the fixture, diff prepared-vs-direct WAT for the
   accessor members, find the illegal shape (likely in the prepared
   class-accessor emission), fix emission or add a backend-legality demote.
3. Re-arm the size row so it runs: either add the accessor file to
   guard-suite.json or fold an equivalent pin into a suite CI runs.

## Acceptance criteria

- An optimizer abort is never silent: result carries an error/warning naming
  it; a test pins this with a deliberately-broken module.
- GETTER_AND_SETTER prepared module optimizes (1007 → materially smaller) or
  demotes typed before optimization; the size row passes un-touched in CI.
- Ratchet gates chained bare before commit.
