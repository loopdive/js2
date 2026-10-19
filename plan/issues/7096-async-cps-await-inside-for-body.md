---
id: 7096
title: "Async-CPS gap: an `await` of a pending promise inside a `for` loop body loses its value (plain `r = await p` and the two-statement form)"
status: ready
created: 2026-10-19
updated: 2026-10-19
priority: medium
horizon: m
feasibility: hard
reasoning_effort: max
task_type: bug
area: compiler
language_feature: async/await
goal: architecture
sprint: current
parent: 5385
related: [7094, 6982, 6979]
---

# #7096 — pending `await` inside a `for` loop body

Found by #7094 (2026-10-19) while measuring the compound-assignment matrix.
Inside a `for` loop body, an `await` of a promise that is still pending when
it is reached reads as 0 (the Promise object itself is added) even in the
plain two-statement form and in `r = await p`. The #7094 fix admitted
compound and binary right operands to the leading-await replay path
(`src/codegen/analysis/async-leading-await-replay.ts`) and saved pre-await
reads across the suspension (`replayPreAwaitReads` in
`src/codegen/async-cps.ts`); loop bodies take neither path. All native lanes
and the host lane agree, so this is the async-CPS planner, not the promise
provider.

## Plan

1. Measure: a `.tmp` matrix on native-first and standalone against Node —
   `for (…) { r += await p; }`, `for (…) { const v = await p; r += v; }`,
   `for (…) { r = await p; }`, `for…of` with the same bodies, `while` and
   `do…while`; with `p` pending vs. already settled; with the loop variable
   read after the await and not. Record which shapes lose the value and
   whether the loop variable itself survives the suspension.
2. Fix in the async-CPS planner: the loop-body suspension must save the loop
   state (induction variable, accumulator) and resume into the body with the
   settled value, the same way the straight-line replay does; keep every
   binary without an `await` inside a loop byte-identical.
3. Tests: a focused test under native-first and standalone vs Node; test262
   `language/statements/for*/` + `expressions/await/` rows with awaits in
   loop bodies before/after on standalone (deterministic delta only).
4. Acceptance: equivalence gate "No new equivalence regressions"; no host
   import; direct-AST freeze respected (planner/analysis code, no new body
   emitter semantics).
