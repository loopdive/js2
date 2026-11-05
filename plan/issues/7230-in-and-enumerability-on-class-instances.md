---
id: 7230
title: "`\"m\" in x` misses subclass-only methods; enumerators ignore `defineProperty({enumerable:false})` on class instances"
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
language_feature: classes
goal: correctness
related: [7216, 7200]
---

# #7230 — prototype membership and enumerability

Found while implementing #7216 (PR #7051). On main:

```js
class A {} class B extends A { m() {} }
const x: A = new B();
console.log("m" in x);   // node: true — we: false (also through any)

class C { a = 1 }
const c = new C();
Object.defineProperty(c, "a", { enumerable: false });
console.log(Object.keys(c));   // node: [] — runtime enumerators list "a"
```

## Plan

1. `in`: consult the runtime prototype chain (methods/accessors of the
   instance's own class and ancestors), not the static class.
2. Enumerators: honour a per-instance enumerable flag set by
   `defineProperty` on a declared field.
3. Tests on 3 lanes against node.
