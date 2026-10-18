---
id: 7080
title: "standalone: a callable-value dispatch arm whose closure returns `externref` drops the live result when the call reads a number/boolean (`each((e) => e.length)` answers NaN)"
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
language_feature: closures, callbacks
related: [7013, 5328]
loc-budget-allow:
  # 2026-10-18 (#7080) call-identifier.ts +5: one call line + one bridge fallback;
  #   the bridge lives in the new expressions/callable-result-unbox.ts.
  - src/codegen/expressions/call-identifier.ts
func-budget-allow:
  # 2026-10-18 (#7080) +3: one helper call and the bridge fallback.
  - src/codegen/expressions/call-identifier.ts::compileBoundIdentifierCall
coercion-sites-allow:
  # 2026-10-18 (#7080) the host-free twin of the dispatch ladder's existing
  #   scalar result bridge (which already names `__unbox_number`/`__is_truthy`
  #   for the host lane); a pure call to the same defined helpers, no new matrix.
  - src/codegen/expressions/callable-result-unbox.ts
---

# Callable dispatch drops an externref result standalone

```ts
function each(fn: (a: any) => number) { return fn("abc"); }
each((e) => e.length);   // 3; standalone NaN
```

## Implementation Plan

The funcref ladder in `call-identifier.ts` reaches the externref-returning arm
and calls it, then drops the value and pushes the undefined sentinel: its scalar
bridge planner returns `null` on every host-free target (it was built for the
host lane's `__box_number`/`__unbox_number` imports). On standalone those are
DEFINED native union helpers — no index shift. Add a host-free result bridge
(`__unbox_number` for an f64 reader, `__is_truthy` for a boolean reader) used
after the existing planners decline, and register the helpers before the
detached arm list is built. New leaf `expressions/callable-result-unbox.ts`.

## Resolution

Implemented. Not covered (recorded): when the CALLEE closure's parameter types
differ from the declared callable type (`eachAny((x: number) => x + 1)` with
`fn: (a: any) => any`), the argument is not admitted at all and the call throws
— the argument bridges stay host-lane-only.
