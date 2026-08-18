---
id: 3762
title: "ES5 String.prototype.replace searchValue/replaceValue coercion order"
status: done
completed: 2026-07-28
created: 2026-07-28
priority: high
task_type: bugfix
area: runtime
goal: es5
es_edition: 5
assignee: ttraenkler/codex-es5-string-replace
sprint: 78
loc-budget-allow:
  - src/runtime.ts
---

# #3762 — ES5 `String.prototype.replace` coercion order

## Problem

The host bridge eagerly coerces a Wasm-struct `replaceValue` before invoking
the native `String.prototype.replace` algorithm. ES5 requires coercing
`searchValue` first, so a throwing `replaceValue.toString` incorrectly wins
over a throwing `searchValue.toString`.

The current-main authoritative Test262 failures are:

- `S15.5.4.11_A1_T11.js`
- `S15.5.4.11_A1_T12.js`

Both report `inreplaceValue` where the expected abrupt completion is
`insearchValue`.

## Fix

Pass positively identified data-struct arguments to the native algorithm as
host proxies instead of eagerly applying `ToPrimitive`. Other argument shapes,
including function replacers, keep their existing behavior so this bounded
slice does not overlap the RegExp/function-replacer lane.

## Acceptance criteria

- Both ES5 Test262 cases pass in the host lane.
- Function-replacer and RegExp cases retain their baseline status.
- The surrounding `String.prototype.replace` corpus has no regressions.
- Standalone remains unchanged; dynamic object search values are explicitly
  refused by its existing `#1474` symbol-protocol boundary.
