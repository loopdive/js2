---
id: 7083
title: "standalone: `s.slice(a, end)` with a DYNAMIC `undefined` end reads end = 0 instead of the length (hono `getQueryParam` answers \"\")"
status: done
sprint: current
created: 2026-10-18
updated: 2026-10-18
completed: 2026-10-18
assignee: ttraenkler/wave17-hono-residual
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: compiler
goal: standalone-gap
language_feature: strings
related: [7013, 2124, 2600]
loc-budget-allow:
  # 2026-10-18 (#7083) string-ops.ts +25: the dynamic-undefined select inside
  #   `compileStringIntegerArg`'s host-free arm.
  - src/codegen/string-ops.ts
func-budget-allow:
  # 2026-10-18 (#7083) +25 inside the existing host-free arm.
  - src/codegen/string-ops.ts::compileStringIntegerArg
---

# Dynamic `undefined` string bounds

hono `_getQueryParam` returns `url.slice(valueIndex, endIndex === -1 ? void 0 : endIndex)`.
The static `undefined` spelling is special-cased by the call sites (#2124), but
a value that is undefined at RUNTIME went through ToNumber → NaN → 0.

## Implementation Plan

In `compileStringIntegerArg`'s host-free arm, when the argument is an externref
and the position has a distinct `undefinedFallback` (slice/substring end,
substr length), compute the ordinary integer and `select` the fallback when
`__extern_is_undefined(arg)`. ToNumber(undefined) has no side effect, so the
eager computation is unobservable; `null` stays 0.

## Resolution

Implemented; hono `getQueryParam` tests progress (the remaining failure needs
`URLSearchParams`).
