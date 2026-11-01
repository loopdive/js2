---
id: 7216
title: "`Object.keys` on a subclass instance typed as its base class lists only the base's keys"
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
related: [7199]
---

# #7216 — Object.keys sees the static type, not the instance

Found while implementing #7199, confirmed on main by the PR #7017 review
(gc and standalone):

```ts
class Animal { name = 'a' }
class Dog extends Animal { breed = 'b' }
const xs: Animal[] = [new Dog()];
console.log(Object.keys(xs[0]).join());   // node: name,breed — we: name
```

`JSON.stringify(xs[0])` is correct, so `Object.keys` picks its arm from the
static type instead of the runtime struct.

## Plan

1. Find the `Object.keys` lowering for a class-typed receiver and make it
   dispatch on the runtime type (or fall back to the runtime path) when the
   class has subclasses.
2. Check `Object.entries`, `Object.values`, `for…in` and spread the same way.
3. Tests on 3 lanes against node.
