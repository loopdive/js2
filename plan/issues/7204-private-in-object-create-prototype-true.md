---
id: 7204
title: "`#x in Object.create(C.prototype)` returns true instead of false"
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
language_feature: classes
goal: correctness
related: [7160]
---

# #7204 — brands are not inherited through `Object.create(C.prototype)`

Found by the PR #7003 review (#7160), finding 3. Every lane gets this wrong,
both on main and with #7160:

```js
class C { #x = 1; static has(v) { return #x in v; } }
console.log(C.has(Object.create(C.prototype)));   // true   (node: false)
```

#7160 fixed `#x in C`, `#x in C.prototype` and `#x in Object.create(new C())`.
This form still passes, because the object created from the prototype shares
the instance struct type and `__tag`, but it never ran C's field
initialisers.

## Plan

1. Find what `Object.create(C.prototype)` allocates and how it differs from
   `new C()`.
2. Make the brand test reject objects that never went through C's
   constructor, for example with a brand slot written by the field
   initialiser.
3. Tests on all 3 lanes against node, including a subclass prototype.
