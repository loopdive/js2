---
id: 4014
title: "arr.hasOwnProperty("data") returns TRUE — the vec's internal WasmGC struct field leaks as an own property"
status: ready
sprint: current
created: 2026-08-01
updated: 2026-08-01
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: n/a
goal: standalone-gap
related: []
---

# arr.hasOwnProperty("data") returns TRUE — the vec's internal WasmGC struct field leaks as an own property

## Problem

`arr.hasOwnProperty("data")` returns **`true`**. `data` is the vec's **internal
WasmGC struct field**, not a JavaScript own property.

Cause: the compile-time const-fold in `object-ops.ts` builds its key set from the
**WasmGC struct field names** and filters only `__`-prefixed ones. Any internal
field whose name does not start with `__` leaks into the observable own-property
set.

## Why it matters beyond one key

The filter is a **naming convention doing the work of a type distinction**. Every
present and future non-`__` internal field is exposed the same way, and each one
is a silently wrong `true` from a predicate that tests are entitled to trust.
Fixing `data` alone leaves the mechanism intact — audit the whole struct-field →
key-set derivation and use an explicit allow/deny of *observable* keys rather
than a prefix heuristic.

Also check the sibling reflection paths (`Object.getOwnPropertyNames`,
`for-in`, `Object.keys`) for the same leak — `hasOwnProperty` is just where it was
noticed.

Found incidentally by `L-descriptor` 2026-08-01 while working #3991. Unowned,
probably previously unknown.
