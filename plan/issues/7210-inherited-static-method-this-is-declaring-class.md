---
id: 7210
title: "Inherited static method sees the declaring class as `this`"
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
related: [7162]
---

# #7210 — `this` in an inherited static method

Documented as an omission by PR #7011 (#7162) and confirmed by its review.
When a subclass calls a static method it inherits, the method body is
compiled with `this` bound to the class that declares it, not to the
receiver:

```js
class C { static #st = 1; static st() { return #st in this; } }
class D extends C {}
console.log(D.st());   // node: false — we print: true (all lanes)
```

Before #7162 this threw TypeError. The `#st in this` check is just the
easiest way to see it; any static method that reads `this` is affected
(`this === D`, `this.name`, static properties shadowed on `D`).

## Plan

1. Find where static method calls resolve `this` (the `__class_<C>` global
   of the declaring class) and pass the actual receiver class value when the
   callee is reached through a subclass.
2. Tests on 3 lanes against node: `this === D`, `this.name`, a static
   property shadowed on `D`, and `#st in this`.
