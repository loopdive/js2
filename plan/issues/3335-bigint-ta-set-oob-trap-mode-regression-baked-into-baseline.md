---
id: 3335
title: "Six TypedArray/set/BigInt failures worsened catchable-error → uncatchable oob trap on main; scheduled baseline refresh baked the worse mode in"
status: ready
sprint: current
priority: high
horizon: m
feasibility: medium
task_type: bug
area: codegen
goal: standalone-mode
created: 2026-07-17
related: [3189, 3198, 3177]
---

# #3335 — BigInt TA `set` failure-mode regression (catchable → oob trap) + baseline-refresh process gap

## Problem (two parts)

**Part 1 — the regression.** A merge on main between `deee48c` and `956e09b9ec`
(2026-07-17, roughly 01:00–04:00Z window) changed the failure MODE of six
`test/built-ins/TypedArray/prototype/set/BigInt/*` files from a catchable
JS error ("undefined is not a constructor") to an **uncatchable Wasm
`offset is out of bounds` trap**. Pass-count was unchanged (fail→fail), so no
regression gate flagged it — only the #3189 oob-trap ratchet moved (45→51, +6).

Evidence (from PR #3177's re-park diagnosis, cross-confirmed by unrelated
PR #3198 parking on the identical +6/same-six signature):
- baselines@01c0962 (from main@deee48c): six files fail catchably.
- baselines@f4d1367 (from main@956e09b9ec, no PR in the mix): same six fail
  as oob traps.

**Task:** bisect `deee48c..956e09b9ec` for the culprit merge and restore a
catchable failure mode (or a genuine pass) for the six files. Trap-mode
worsening is a real quality regression even at equal pass-count — traps are
uncatchable, kill fork workers, and violate the refuse-loudly principle.

## Part 2 — the process gap

The scheduled baseline refresh captured the worse mode into
`js2wasm-baselines`, silently RAISING the #3189 ratchet floor from 45 to 51.
The ratchet correctly caught the change on PR runs (parking two innocent
PRs), but the refresh then normalized it — meaning main-side trap-mode
regressions self-legalize within one refresh cycle.

**Task:** make the scheduled/promote baseline refresh refuse (or loudly flag)
an INCREASE in the oob-trap count relative to the previous baseline, so
main-side worsening needs an explicit acknowledgment (same spirit as the
`regressions-allow:` mechanism) instead of being baked in.

## Acceptance

- Culprit merge identified; the six files fail catchably (or pass) again;
  oob ratchet returns ≤45.
- Baseline refresh (scheduled + promote paths) alerts or fails on oob-count
  increases, with a documented override for intentional changes.
- Note the resolution in #3198/#3177 (both were parked as collateral).
