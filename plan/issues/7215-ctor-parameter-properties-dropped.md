---
id: 7215
title: "Constructor parameter properties (`constructor(public x)`) are never stored"
status: ready
sprint: Backlog
created: 2026-10-31
updated: 2026-10-31
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: classes
goal: correctness
related: [7199]
---

# #7215 — TypeScript parameter properties are dropped

Found while implementing #7199 and confirmed by the PR #7017 review on main
(9e82d60c42), all 3 lanes:

```ts
class A { constructor(public x: number, public y: string) {} }
const a = new A(1, 'p');
console.log(JSON.stringify(a), a.x);   // node: {"x":1,"y":"p"} 1 — we: {} NaN
```

## Plan

1. Find where class fields are collected and make parameter properties
   (`public`/`private`/`protected`/`readonly` on constructor params)
   declare fields and emit the `this.x = x` stores at the start of the
   constructor body, before user statements and after `super(...)`.
2. Tests on 3 lanes: plain, `readonly`, mixed with normal fields and
   initializers (order), in a subclass with `super`, and JSON/keys order.
