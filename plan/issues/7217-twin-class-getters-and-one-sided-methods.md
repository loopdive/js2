---
id: 7217
title: "Twin-layout classes: getters unguarded, and a method on one twin shows on the other"
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
related: [7199, 7200]
---

# #7217 — getters and one-sided methods on twin classes

Found by the PR #7017 (#7199) review. #7199 guards method dispatch on twin
classes (same layout, different classes), but not getters, and not names that
only one twin declares. Both reproduce on main:

```js
class X { a = 1; get g() { return 'x'; } }
class Y { b = 2; get g() { return 'y'; } }
const v = [new X(), new Y()];
console.log(v[1].g);   // node: y — gc/standalone: trap; wasi: x

class P { a = 1; only() {} }
class Q { b = 2 }
console.log(typeof new Q().only);   // node: undefined — we: function
```

## Plan

1. Reuse `hasLayoutTwin` from `src/codegen/class-arm-tag-guard.ts` to add the
   `__tag` guard to getter/setter dispatch and to the per-name presence check.
2. Coordinate with #7200 (`hasOwnProperty` / `in`), which is the same family.
3. Tests on 3 lanes against node.
