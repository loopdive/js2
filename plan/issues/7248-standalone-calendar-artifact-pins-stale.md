---
id: 7248
title: "Stale pins: three #4577 standalone Calendar artifact rows fail on main (terminal census 41 vs 38, redundant TDZ guards, `$__cb_0` missing)"
status: ready
created: 2026-11-05
updated: 2026-11-05
priority: low
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: test
area: tests
language_feature: compiler-internals
goal: architecture
sprint: current
parent: 4577
related: [6979, 7143]
---

# #7248 — re-anchor the #4577 Calendar artifact pins

Found by the S7-b fix-on-touch pass (2026-11-05): three rows of
`tests/issue-4577-standalone-calendar-retirement.test.ts` fail on main
before and after S7 (marked `it.fails` on PR 6705; S7-b only renamed the
policy-class key in the file):

- "keeps the post-timer exact 38-terminal census at 38/0 with no Invariant":
  the exact standalone terminal population is 41, not 38 (three units joined
  the census since the pin — same shape as the #3523 R4 `nonExecutableFloor`
  correction in `scripts/ir-only-baseline.json`).
- "retains direct arithmetic/DOM shapes and seven static callback bodies":
  `renderCal` carries 37 "redundant module TDZ guards" where the pin expects
  0.
- "keeps tuned Calendar artifacts at or below the direct-relative ceilings":
  the unique WAT function `$__cb_0` is no longer emitted.

## Plan

1. Measure: `git bisect` main between the last green run of this file and
   today for each row separately (they may have three different causes:
   #7143 A1 ratchet work for the census, the TDZ-guard elision change for
   the second, callback naming for the third).
2. Re-anchor each pin to the current standalone output with a dated note
   naming the commit that changed it, or fix the regression if the bisect
   shows an unintended change (the 37 redundant TDZ guards look like one).
3. Turn the three `it.fails` rows back into normal rows.
