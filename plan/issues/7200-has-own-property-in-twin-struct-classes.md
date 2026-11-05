---
id: 7200
title: "hasOwnProperty / `in` on twin-layout class instances report the twin's fields"
status: done
sprint: Backlog
created: 2026-10-31
updated: 2026-11-01
completed: 2026-11-01
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: classes
goal: correctness
related: [7158, 7199]
# 2026-11-01: +7 lines — the #7200 `__tag` guard on the closed-struct
# own-property arms (`fillClosedStructHasOwnArms`) must live where the arms are
# built; the tag computation itself is in class-arm-tag-guard.ts.
loc-budget-allow:
  - src/codegen/object-runtime.ts
---

# #7200 — own-property lookup still collapses twin class layouts

Found by the review of PR #6996 (#7158), finding 2. #7158 fixed the enumeration
arms (JSON.stringify, Object.keys/assign, for-in, spread), but `hasOwnProperty`
and `in` use a different lookup path and still match the twin class.

```js
class A { a = 1 }
class B { b = 1 }
const o: any = new B();
console.log(o.hasOwnProperty("a"), "a" in o);
// node: false false
// gc native-first and standalone (base and #6996): true true
```

## Plan

1. Find the own-property lookup for closed class structs (the `in` /
   hasOwnProperty lowering for `any` receivers) and apply the same `__tag`
   discrimination as `enumerationArmTagGuard` in
   `src/codegen/class-arm-tag-guard.ts`.
2. Tests on all 3 lanes against node, including subclass pairs.

## Resolution (2026-11-01)

`fillClosedStructHasOwnArms` built one `ref.test $S` arm per (field, struct)
for `__hasOwnProperty`, `__object_hasOwn`, `__propertyIsEnumerable` and
`__extern_has` (`in`). A twin's instance passes that structural test, so the
arm for `A.a` answered `true` for a `B`. Each arm now carries the nominal
`__tag` guard: `classArmTags` (split out of `classArmTagCondition`, own tag plus
descendants', `undefined` when `hasLayoutTwin` finds no twin) feeds the existing
`enumerationArmTagGuard`. The edit is inside the arm bodies; the
`ctx.standalone` gate is untouched (#7201 / PR #7020 owns it).

Covered: `hasOwnProperty`, `Object.hasOwn`,
`Object.prototype.hasOwnProperty.call`, `propertyIsEnumerable`, `in`, and
`Object.getOwnPropertyDescriptor` on an `any` receiver (it reads through
`__hasOwnProperty`). Programs without twins are byte-identical on gc,
standalone and wasi.

Left out:

- **wasi** has no closed-struct own-property arms until PR #7020 lands, so it
  answers `false` for every field (twin or not); its rows in the test are
  limited to those that already pass.
- **Writing a twin's field name onto the other twin** (`const o: any = new B();
  o.a = 5`) still stores into `B`'s slot through the member-set dispatcher and
  `__extern_set`, which have no tag guard (base already corrupted `o.b` to 5).
  Base answered `o.hasOwnProperty("a")` true only because every twin field read
  as own; this change answers `false` there. Fixing it needs the same guard on
  the member get/set dispatchers and the inline IC, which is #7217's scope.
- `"m" in o` for a prototype method or getter is `false` on base and head
  regardless of twins (separate gap).

**Test:** `tests/equivalence/issue-7200-twin-hasown-in.test.ts`.
