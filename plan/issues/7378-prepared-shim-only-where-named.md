---
id: 7378
title: "Prepared path: emit the test262 `$262` shim only for files that name it"
status: backlog
sprint: Backlog
created: 2026-11-19
updated: 2026-11-19
priority: critical
horizon: s
feasibility: medium
reasoning_effort: high
task_type: implementation
area: ir, test262
goal: ir-full-coverage
related: [7354, 7106, 7349, 7350, 7352]
---

# Prepared path: emit the `$262` shim only where a test names it

Source: `plan/log/ir-migration-strategy-review-2026-11-19.md` (strategy review, 2026-11-19, main `89e47482`). Recommendation R1.

## Problem

Every test on the Prepared path (the IR-only whole-program pipeline, `TEST262_COMPILER_PATH=ir`) is compiled behind
`scripts/test262-fyi-runtime.js` + `harness/assert.js` + `harness/sta.js`. The first file is the project's own
111-line shim. To build `$262` it reads 28 globals, among them `Proxy`, `Map`, `WeakMap`, `Promise`, `Symbol`
and `eval` (`globalThis` 22 times).

Measured 2026-11-19 on main `89e47482` by parsing all 8,717 positive ES5 files:

- 21 files name `$262`; none calls `print`.
- 7,654 files (87.8 %) include nothing beyond `assert.js` + `sta.js`.

So ES2015+ globals are a precondition of the first passing ES5 test, for the sake of 21 files. Milestone M of #7354
(real prelude compiles, one positive test passes) is larger than it needs to be.

## To decide

- Where the "names `$262`" test lives (the runner already knows a test's includes; the stand-in harness on PR #7308
  does the same for its own functions).
- Whether the ordinary pipeline keeps the unconditional shim (its output must not change unless measured).

## Acceptance criteria

1. A test that does not name `$262` (or `print`) compiles on the Prepared path without the shim's global reads.
2. The 21 files that name it still get it.
3. No verdict changes on the ordinary standalone lane (full run or the edition ratchet).
4. The first-gap tally of the 411-row sample is reported before and after.
