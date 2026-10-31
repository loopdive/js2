---
id: 7209
title: "`o.x` on a number argument reads NaN when another call site passes an object literal"
status: ready
sprint: Backlog
created: 2026-10-31
updated: 2026-10-31
priority: low
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: functions
goal: correctness
related: [7161]
---

# #7209 — mixed object-literal/number call sites

Found by the PR #7008 round-2 review. This is already on main and needs no
Proxy:

```js
function t(o) { return o.x; }
console.log(t({ x: 1 }) + ";" + t(5));   // node: 1;undefined — we print: 1;NaN
```

With a class instance in place of the object literal, gc and standalone give
`undefined` correctly. The object-literal case narrows `o.x` to an f64 field
read and does not fall back for the number argument.

## Plan

1. Find how call-site inference treats an untyped parameter that receives
   both an object literal and a scalar, and make `o.x` on a non-object read
   `undefined`.
2. Tests on 3 lanes against node: object literal plus number or boolean, in
   both orders.
