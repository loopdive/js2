---
id: 7081
title: "standalone: `shift()` / `unshift()` on an `any` array are silent no-ops (hono `splitPath` keeps the leading empty segment)"
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
language_feature: arrays
related: [7013, 6701, 2927]
---

# `shift`/`unshift` on a dynamic array do nothing standalone

hono `splitPath("/hello")` returned `["", "hello"]`: `paths.shift()` on the
`split` result (`any` in an untyped module) answered `undefined` and mutated
nothing. `push`/`pop` (#2927), `splice` (#6701) and the producers (#6447) have
`$__vec_base` arms in the closed-method dispatcher; `shift`/`unshift` did not.

## Implementation Plan

New leaf `array/array-shift-native.ts`: `__arrprod_shift` / `__arrprod_unshift`
on the `__arrprod_splice` substrate (`__extern_length`, `__extern_get_idx`,
`__extern_has_idx`, strict `__extern_set`, `__delete_property`), §23.1.3.27 /
§23.1.3.36 including hole preservation and the 2^53−1 TypeError. Register both
in `DYN_ARRAY_PRODUCER_METHODS` so the dispatcher's producer arm claims them.

## Resolution

Implemented; hono `utils/url` `splitPath`/`splitRoutingPath` pass.

Regression: `tests/issue-7059-hono-standalone-residuals.test.ts` (the `#7081` block).
