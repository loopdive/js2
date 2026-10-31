---
id: 7203
title: "A static method called through an `any`-typed class value receives the class as its first argument"
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
related: [7160]
---

# #7203 — `A.id(5)` returns the class when `A: any`

Found by the PR #7003 review (#7160), finding 2. This bug is already on
main, on gc native-first and standalone:

```js
class K { static id(x) { return x; } }
const A: any = K;
console.log(A.id(5) === K);   // true   (node: false; A.id(5) is 5)
```

The receiver (the class value) is passed as the first explicit argument
instead of as `this`. Factory-made and loop-made classes reach static methods
this way. One visible effect: before #7160, `A.has(new A())` answered true by
accident; it also answered true for `A.has({})`.

## Plan

1. Find the dynamic static-method call path for `any` receivers that resolve
   to a class value, and check how it builds the argument list.
2. Pass the receiver as `this` and the user arguments unchanged.
3. Tests on all 3 lanes against node: an `any` alias, a factory class, a class
   made in a loop, and a static method that reads `this`.
