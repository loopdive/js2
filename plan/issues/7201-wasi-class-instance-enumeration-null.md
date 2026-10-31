---
id: 7201
title: "wasi: JSON.stringify / Object.entries / hasOwnProperty on any class instance return null or nothing"
status: ready
sprint: Backlog
created: 2026-10-31
updated: 2026-10-31
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: classes
goal: correctness
related: [7158]
---

# #7201 — wasi class-instance enumeration is broken even with one class

Found while implementing #7158 and confirmed by the PR #6996 review (finding 5).
It is unrelated to twin layouts and is present on main.

```js
class A { a = 1 }
console.log(JSON.stringify(new A()));                 // node: {"a":1}  wasi: null
console.log(JSON.stringify(Object.entries(new A()))); // wasi: wrong
console.log((new A() as any).hasOwnProperty("a"));    // wasi: wrong
```

for-in, `Object.getOwnPropertyNames` and `Object.assign` from a class instance
also return null or nothing on wasi. gc native-first and standalone are correct.

## Plan

1. Diff the wasi lowering of the closed-struct enumeration consumers against
   standalone and find where class structs drop out.
2. Tests: wasi rows for every consumer in
   `tests/equivalence/issue-7158-twin-struct-layouts.test.ts`, against node.
