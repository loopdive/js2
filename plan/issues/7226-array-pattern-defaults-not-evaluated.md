---
id: 7226
title: "Array-pattern defaults are never evaluated (`[a = 5] = []` leaves `a` as NaN)"
status: ready
sprint: Backlog
created: 2026-11-04
updated: 2026-11-04
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: destructuring
goal: correctness
related: [7164]
---

# #7226 — array-pattern defaults

Found by the PR #6944 (#7164) round-12 review. On main and head alike:

```js
let a;
[a = 5] = [];
console.log(a);   // node: 5 — we: NaN
```

The default expression is never evaluated, so side effects inside it are lost
too (`[a = (g.length += 7)] = []`).

## Plan

1. Find the array destructuring-assignment lowering (assignment targets, not
   declarations) and evaluate the default when the element is undefined,
   exactly once, in order.
2. Tests on 3 lanes against node: declaration vs assignment patterns, nested
   patterns, defaults with side effects, holes.
