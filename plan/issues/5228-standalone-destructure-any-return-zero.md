---
id: 5228
title: "Standalone: destructuring the any-typed return of a call answers 0 for every property — const { year: n } = f() reads 0 regardless of shape"
status: ready
sprint: current
priority: medium
horizon: m
goal: standalone-gap
reasoning_effort: max
requested_by: ttraenkler/fable-lead
created: 2026-08-30
---

# #5228 — standalone destructure of an `any` call result reads 0

## Problem

In standalone mode, `const { year: n } = f()` where `f`'s return type
resolves to `any` binds `n = 0` for **every** object shape — no shadowing or
TDZ involved (distinct from #5221's defect 2/3, which this repro was reduced
away from). The host lane answers correctly. Consistent with the #5221
through-line: a slot/shape mismatch is silently coerced (here to a zero
scalar) instead of being routed through a dynamic property read or rejected
at compile time.

## Direction

Locate where standalone destructuring lowers the initializer when the source
type is unresolvable — likely `src/codegen/destructuring*.ts` /
`statements.ts` choosing a scalar slot for the bound name and defaulting the
read to `0` when no struct type is known. Correct behavior: route through the
standalone dynamic property-get path (the #2860 family machinery), or demote
to a compile error if that path can't serve the shape — never a silent 0.

## Acceptance criteria

1. `const { year: n } = f()` (f returning `any`-typed object) answers the
   real property value in standalone; several shapes covered.
2. New `tests/issue-5228-*.test.ts` failing on base in the standalone lane,
   host-lane control passing on base.
3. No standalone floor/net regressions; gates green.

## Notes

- Found by dev-5221 (PR #5334 "Not fixed here" list) — it is why the
  defect-3 repro in `tests/issue-5221-*.test.ts` has no standalone row.
- Id reserved with a degraded PR scan; manually checked against open PR head
  branches 2026-08-30.
