---
id: 6807
title: "standalone: `\"1,2\" == arr` is false, `[1] == [1]` is true, `String(boolArr)` is \"1,0\""
status: ready
sprint: Backlog
created: 2026-10-01
updated: 2026-10-01
priority: medium
horizon: s
feasibility: medium
reasoning_effort: medium
task_type: bug
area: codegen
language_feature: type-coercion
goal: standalone-gap
related: [6788, 6806, 2358, 2860]
requested_by: ttraenkler/claude-review
origin: "measured on the parent by the #6788 implementation (2026-10-01, its standalone harness) and left out of its scope"
---

# #6807 — standalone residue found by #6788

Three rows reproduced by dev-6788 on `target: "standalone"` at the #6788
parent (`c810079652`), unchanged by #6788 (which only touched the host lane):

| source | standalone | JS | note |
|---|---|---|---|
| `"1,2" == arr` (string on the LEFT) | `false` | `true` | the array-on-the-left arm of `==` reduces via `array-to-primitive.ts` (#2358); the string-left arm does not |
| `[1] == [1]` | `true` | `false` | two distinct vecs compare equal — looks like a structural/element compare where §7.2.15 step 1 requires identity for two objects |
| `String([true, false])` | `"1,0"` | `"true,false"` | the standalone join formats the i32 vec as numbers (standalone twin of #6806) |

Not re-measured on `9d977a7e` by the filer (the host-lane probe harness does
not run standalone modules); re-verify with the standalone harness used in
`tests/issue-6788-array-carrier-toprimitive.test.ts` before dispatch.

## Correction

- `==` with an array carrier on either side: object-vs-object is identity
  (`ref.eq`); object-vs-primitive reduces the object with ToPrimitive and
  compares the result. One symmetric lowering for both operand orders.
- Standalone join: element-kind-aware formatting (shared with #6806's host
  fix if the stringifier is in-module).

## Acceptance

- Three rows match JS on `target: "standalone"`; host lane asserted
  unchanged.
- Rows added to the standalone block of
  `tests/issue-6788-array-carrier-toprimitive.test.ts`.
