---
id: 3761
title: "String.prototype.split explicit NaN limit is mistaken for omission"
status: done
created: 2026-07-28
updated: 2026-07-28
completed: 2026-07-28
priority: medium
feasibility: easy
reasoning_effort: medium
task_type: bug
area: codegen
es_edition: ES5
language_feature: string-prototype-split
goal: test262-conformance
assignee: ttraenkler/codex-es5-string-split
related: [1441, 2125]
---

# #3761 — distinguish explicit NaN from an omitted split limit

## Problem

The host ABI pads a missing `String.prototype.split` limit with `NaN`, then
removes a trailing `NaN` before invoking the JavaScript host method. An explicit
`NaN` is therefore also removed, despite ES5 requiring `ToUint32(NaN) = 0`.

The ES5 test
`built-ins/String/prototype/split/call-split-l-na-n-instance-is-string-hello.js`
returns three pieces instead of an empty array in the host lane.

## Fix

Use `-1` as the omitted-limit ABI sentinel. `ToUint32(-1)` is `2^32 - 1`, so
an explicit `-1` and an omitted limit are observably equivalent for split,
while an explicit `NaN` remains available for the host method to coerce to zero.

## Acceptance criteria

- Explicit `NaN` returns an empty result in host and standalone modes.
- Omitted and explicit `-1` limits remain unbounded.
- The exact ES5 test flips to pass in the host lane.
- The 70-test non-RegExp ES5 split partition has no pass-to-fail regressions.

## Measured result

Local-vs-local A/B at `origin/main@a790605025acb28065bd9de63a84e0f72b8bd360`:

- Host non-RegExp ES5 split partition: **56/70 → 57/70**, with the exact NaN
  limit test as the sole fail-to-pass flip and zero regressions.
- Standalone non-RegExp ES5 split partition: **35/70 → 35/70**, with zero
  changes and zero regressions. The standalone helper already computes the
  correct empty length for explicit NaN; that test remains red only because a
  subsequent out-of-bounds element read returns `null` rather than `undefined`,
  a separate array/value-representation residual.
- Focused split tests: **23/23 pass** across #3761, #1441, and #2125.
