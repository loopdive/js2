---
id: 7409
title: "RegExp pattern compiler: an open-ended quantifier `{n,}` above the expansion cap exhausts the heap instead of refusing"
status: done
sprint: current
created: 2026-11-19
updated: 2026-11-19
completed: 2026-11-19
priority: medium
horizon: s
feasibility: easy
reasoning_effort: high
task_type: bugfix
area: compiler
goal: ir-full-coverage
depends_on: []
related: [1539, 7369]
---

# #7409 — `{n,}` above the expansion cap exhausts the compiler heap

## Problem

`staging/sm/RegExp/regress-yarr-regexp.js` makes the compiler run out of a 3 GB heap on the default and standalone
targets, on main `89e47482` (found by #7369 R0's byte-identity run). Reproduced at `--max-old-space-size=400`:

| pattern | before |
| --- | --- |
| `x{2147483648}x` | `RepeatTooLargeError` (named) |
| `x{2147483647,2147483648}x` | `RepeatTooLargeError` (named) |
| `x{2147483648,}x` | heap out of memory |
| `x{1001,}` | compiles 1,001 mandatory copies |

Parsing is not the cost (`parsePattern` returns in 1 ms). `compileRepeat` in `src/codegen/regex/compile.ts` checks
`MAX_REPEAT_EXPANSION` (1,000) only when the quantifier has an upper bound
(`max !== -1 && (max > CAP || min > CAP)`), and then expands `min` mandatory copies for `{min,}` too. So an open-ended
quantifier skips the cap and expands up to 2^31 copies.

## Implementation Plan

- **Module:** `compileRepeat` in `src/codegen/regex/compile.ts`. The cap reads `min` whatever `max` is:
  `min > CAP || (max !== -1 && max > CAP)`. Nothing else changes: the refusal is the existing `RepeatTooLargeError`,
  which the standalone engine already reports as an unsupported pattern.
- **Reuse:** the existing cap and error class; no new mechanism.
- **Quality criterion:** one condition changed; no new branch. Compiled output of every RegExp-using test262 file
  is identical on default, standalone and linear, apart from the file this fixes.

## Result

- `x{2147483648,}x` and `x{1001,}` now throw `RepeatTooLargeError`. A standalone compile of the test262 shape
  refuses with "… `{2147483648,}` exceeds expansion cap". Below the cap, `{3,}` and `{1000,}` compile and match as
  node does. Pinned in `tests/issue-7409-regexp-open-repeat-cap.test.ts`; before the fix, `x{1001,}` compiled, so
  the pin fails on main.
