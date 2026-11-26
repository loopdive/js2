---
id: 7466
title: "Retire legacy standalone for-in helpers once realm objects are enumerated natively"
status: backlog
sprint: Backlog
created: 2026-11-26
updated: 2026-11-26
priority: low
horizon: s
feasibility: medium
reasoning_effort: high
task_type: refactor
area: codegen, runtime
goal: ir-full-coverage
depends_on: [7377]
related: [7354, 7377, 2964, 3274]
origin: "2026-11-26 PRV-O5 review of the #7377 plan (R8)"
---

# #7466: retire the legacy standalone for-in helpers

## Problem

Two implementations of EnumerateObjectProperties exist:

- **Legacy standalone** `__object_keys_forin`, with `__extern_length`, `__extern_get_idx` and `__extern_has`
  (`src/codegen/object-runtime-enumeration.ts`). It walks codegen's own object layout.
- **The realm row `js.object.for-in-keys`** (#7377), which walks the realm kernel's object struct and property map.

Neither can serve the other's objects today.

## Done when

- The ordinary standalone lane enumerates realm objects through `js.object.for-in-keys` and its key-list rows.
- The legacy helpers lose their last caller and are deleted.
- The JS-environment output stays byte-identical while that lane exists.
