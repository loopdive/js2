---
id: 7086
title: "standalone: `s.concat(x)` on an `any` string throws \"called value is not a function\" (hono `getFilePath`)"
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
related: [7013, 6447]
loc-budget-allow:
  # 2026-10-18 (#7086) object-runtime.ts +70: the `concat` arm of the existing
  #   `__extern_method_call` string fast path (+ its two scratch locals).
  - src/codegen/object-runtime.ts
func-budget-allow:
  - src/codegen/object-runtime.ts::ensureObjectRuntime
coercion-sites-allow:
  # 2026-10-18 (#7086) one `__extern_toString` (ToString of each concat argument)
  #   in the existing string fast path of `__extern_method_call`.
  - src/codegen/object-runtime.ts
---

# `String.prototype.concat` on a dynamic receiver

`concat` is also an Array member, so an `any`-receiver call goes to the closed
dispatcher; its `$__vec_base` producer arm owns arrays and a string fell to
`__extern_method_call`, where no string arm answered and the resolved callee
(no String.prototype read on a primitive) was not callable.

## Implementation Plan

Add a `concat` arm to `__extern_method_call`'s native-string fast path:
`recv + ToString(arg_0) + …` over the `$ObjVec` argument carrier
(`__extern_toString`, `__str_concat`).

## Resolution

Implemented; hono `getFilePath` passes. Array `concat` on `any` keeps its arm
(control in the regression test).
