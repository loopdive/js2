---
id: 7200
title: "hasOwnProperty / `in` on twin-layout class instances report the twin's fields"
status: ready
sprint: Backlog
created: 2026-10-31
updated: 2026-10-31
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: classes
goal: correctness
related: [7158, 7199]
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
